'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const G = require('./game');
const Bot = require('./bot');

const PORT = +process.env.PORT || 8500;
const DATA = path.join(__dirname, 'data');
const SAVE = path.join(DATA, 'rooms.json');
fs.mkdirSync(DATA, { recursive: true });

const rooms = new Map(); // code -> room
const BOT_NAMES = ['Sparky', 'Turbo', 'Boiler', 'Ash'];
const TEAM_NAMES = ['Team A', 'Team B'];

// ---------- persistence ----------
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = [];
    for (const r of rooms.values()) { const { conns, timer, autoNext, rate, ...rest } = r; out.push(rest); }
    fs.writeFile(SAVE + '.tmp', JSON.stringify(out), (e) => { if (!e) fs.rename(SAVE + '.tmp', SAVE, () => {}); });
  }, 400);
}
function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
    const cutoff = Date.now() - 14 * 864e5;
    for (const r of arr) {
      if (r.lastActive < cutoff) continue;
      if (r.game.hand) r.game.hand = Object.assign(Object.create(G.Hand.prototype), r.game.hand);
      r.conns = new Set(); r.rate = {};
      rooms.set(r.code, r);
    }
    console.log('loaded', rooms.size, 'rooms');
  } catch (e) { /* no saved rooms */ }
}

// ---------- rooms ----------
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c; do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function newRoom(fast) {
  const r = {
    code: makeCode(), created: Date.now(), lastActive: Date.now(), fast: !!fast,
    seats: [null, null, null, null], names: {},
    game: { status: 'lobby', hand: null, dealer: crypto.randomInt(4), totals: [0, 0], history: [], handNo: 0, winner: null, gameNo: 1 },
    chat: [], msgId: 1, conns: new Set(), rate: {},
  };
  rooms.set(r.code, r); save();
  return r;
}
const seatOf = (r, token) => r.seats.findIndex((s) => s && !s.bot && s.token === token);
const seatName = (r, s) => (r.seats[s] ? r.seats[s].name : 'Seat ' + (s + 1));
const isConnected = (r, token) => [...r.conns].some((ws) => ws.token === token);
function teamLabel(r, t) {
  const n = [t, t + 2].map((s) => r.seats[s] ? r.seats[s].name : '?');
  return n.join(' & ');
}
function sys(r, text) { pushChat(r, { kind: 'sys', text }); }
function pushChat(r, m) {
  m.id = r.msgId++; m.ts = Date.now();
  r.chat.push(m); if (r.chat.length > 300) r.chat.splice(0, r.chat.length - 300);
  broadcastRaw(r, { t: 'chat', msg: m });
}

// ---------- views ----------
function view(r, token) {
  const me = seatOf(r, token);
  const g = r.game, h = g.hand;
  const v = {
    code: r.code, me: { seat: me, name: r.names[token] || '' }, status: g.status,
    seats: r.seats.map((s, i) => s ? { name: s.name, bot: !!s.bot, auto: !!s.auto, connected: s.bot ? true : isConnected(r, s.token), team: i % 2 } : null),
    totals: g.totals, history: g.history, handNo: g.handNo, dealer: g.dealer, winner: g.winner, gameNo: g.gameNo,
    teams: [teamLabel(r, 0), teamLabel(r, 1)], hand: null,
  };
  if (h) {
    const openShown = h.contract && h.contract.type === 'omis' && (h.trickCount > 0 || h.trick.length > 0);
    v.hand = {
      phase: h.phase, turn: h.turn, bids: h.bids, high: h.high, highSeat: h.highSeat, contract: h.contract, contractor: h.contractor,
      trump: h.trump, trick: h.trick, nominated: h.nominated, lastTrick: h.lastTrick, tricksWon: h.tricksWon, teamTricks: h.teamTricks(),
      trickCount: h.trickCount, sitOut: h.sitOut, counts: h.hands.map((x) => x.length), result: h.result,
      myHand: me >= 0 ? h.hands[me] : [], legal: me >= 0 ? h.legal(me) : [],
      openHand: openShown ? h.hands[h.contractor] : null,
      passed: h.passed,
      discards: me >= 0 && me === h.contractor ? h.discards : null,
      kitty: h.phase === 'done' ? h.kitty : null,
    };
  }
  return v;
}
function broadcastRaw(r, msg) { const s = JSON.stringify(msg); for (const ws of r.conns) if (ws.readyState === 1) ws.send(s); }
function broadcast(r) {
  r.lastActive = Date.now();
  for (const ws of r.conns) if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'state', state: view(r, ws.token) }));
  save();
}

// ---------- game flow ----------
function startHand(r) {
  const g = r.game;
  g.dealer = (g.dealer + 1) % 4;
  g.handNo++;
  g.hand = new G.Hand(g.dealer);
  g.status = 'playing';
  sys(r, `Hand ${g.handNo}: ${seatName(r, g.dealer)} deals. ${seatName(r, g.hand.turn)} to bid first.`);
}
function finishHand(r) {
  const g = r.game, h = g.hand;
  const res = h.result;
  const ap = G.applyScores(g.totals, res.delta, res.contractTeam, res.made);
  const actual = [ap.totals[0] - g.totals[0], ap.totals[1] - g.totals[1]];
  g.totals = ap.totals;
  g.history.push({ hand: g.handNo, bidder: seatName(r, h.contractor), team: res.contractTeam, contract: G.bidLabel(h.contract), tricks: res.tricks, bidderTricks: h.tricksWon[h.contractor], made: res.made, delta: actual, totals: g.totals.slice() });
  const ct = res.contractTeam;
  const isMis = h.contract.type !== 'suit';
  sys(r, `${seatName(r, h.contractor)} ${res.made ? 'made' : 'went down in'} ${G.bidLabel(h.contract)}` +
    (isMis ? '' : ` (${res.tricks[ct]} tricks)`) + `. ${TEAM_NAMES[0]} ${fmt(actual[0])}, ${TEAM_NAMES[1]} ${fmt(actual[1])}. Score ${g.totals[0]} – ${g.totals[1]}.`);
  if (ap.winner !== null) {
    g.status = 'gameover'; g.winner = ap.winner;
    sys(r, `🏆 ${TEAM_NAMES[ap.winner]} (${teamLabel(r, ap.winner)}) win the game ${g.totals[ap.winner]} to ${g.totals[1 - ap.winner]}!`);
  } else {
    g.status = 'handover';
    clearTimeout(r.autoNext);
    r.autoNext = setTimeout(() => { if (r.game.status === 'handover') { startHand(r); broadcast(r); runBots(r); } }, r.fast ? 300 : 30000);
  }
}
const fmt = (n) => (n > 0 ? '+' + n : '' + n);

function act(r, seat, a) {
  const g = r.game, h = g.hand;
  if (g.status !== 'playing' || !h) throw new Error('No hand in progress');
  if (a.t === 'bid') {
    const res = h.bid(seat, a.bid);
    sys(r, `${seatName(r, seat)}: ${G.bidLabel(a.bid)}`);
    if (res.redeal) { sys(r, 'Everyone passed. Redealing.'); startHand(r); }
    else if (res.won) sys(r, `${seatName(r, h.contractor)} wins the bid with ${G.bidLabel(h.contract)} and picks up the kitty.` + (h.sitOut !== null ? ` ${seatName(r, h.sitOut)} sits this one out.` : ''));
  } else if (a.t === 'discard') {
    h.discard(seat, a.cards);
    sys(r, `${seatName(r, seat)} has discarded. ${seatName(r, seat)} leads.`);
  } else if (a.t === 'play') {
    const res = h.play(seat, a.card, a.nominate);
    if (a.nominate && h.lastTrick && res.trickWinner === undefined) { /* nominated suit shown in trick */ }
    if (res.trickWinner !== undefined) {
      if (h.phase === 'done') finishHand(r);
    }
  } else throw new Error('Unknown action');
}
function runBots(r) {
  clearTimeout(r.timer);
  const g = r.game, h = g.hand;
  if (g.status !== 'playing' || !h || !['bidding', 'kitty', 'playing'].includes(h.phase)) return;
  const seat = h.turn; const s = r.seats[seat];
  if (!s || !(s.bot || s.auto)) return;
  let delay = r.fast ? 5 : 900 + Math.random() * 500;
  if (!r.fast && h.phase === 'playing' && h.trick.length === 0 && h.lastTrick) delay = 1800;
  r.timer = setTimeout(() => {
    try {
      if (g.hand !== h || h.turn !== seat) return runBots(r);
      if (h.phase === 'bidding') {
        const partnerBid = [...h.bids].reverse().find((b) => b.seat === (seat + 2) % 4 && b.bid.type !== 'pass');
        act(r, seat, { t: 'bid', bid: Bot.chooseBid(h.hands[seat], h.high, partnerBid && partnerBid.bid) });
      } else if (h.phase === 'kitty') act(r, seat, { t: 'discard', cards: Bot.chooseDiscard(h.hands[seat], h.trump) });
      else { const p = Bot.choosePlay(h, seat); act(r, seat, { t: 'play', card: p.card, nominate: p.nominate }); }
    } catch (e) { console.error('bot error', e); }
    broadcast(r); runBots(r);
  }, delay);
}

// ---------- client messages ----------
function handle(ws, m) {
  if (m.t === 'hello') {
    const r = rooms.get(String(m.room || '').toUpperCase());
    if (!r) return send(ws, { t: 'error', msg: 'Room not found. Check the code.', fatal: true });
    if (typeof m.token !== 'string' || m.token.length < 8) return send(ws, { t: 'error', msg: 'Bad token', fatal: true });
    if (ws.room) ws.room.conns.delete(ws);
    ws.room = r; ws.token = m.token.slice(0, 64);
    r.conns.add(ws);
    const name = cleanName(m.name);
    if (name) r.names[ws.token] = name;
    const seat = seatOf(r, ws.token);
    if (seat >= 0) { r.seats[seat].auto = false; if (name) r.seats[seat].name = name; }
    send(ws, { t: 'chatlog', msgs: r.chat.slice(-150) });
    broadcast(r); runBots(r);
    return;
  }
  const r = ws.room; if (!r) return;
  const token = ws.token; const me = seatOf(r, token); const g = r.game;
  switch (m.t) {
    case 'rename': { const n = cleanName(m.name); if (!n) return; r.names[token] = n; if (me >= 0) r.seats[me].name = n; break; }
    case 'sit': {
      const s = m.seat; if (![0, 1, 2, 3].includes(s)) return;
      const name = r.names[token]; if (!name) throw new Error('Enter your name first');
      const cur = r.seats[s];
      if (g.status === 'lobby') {
        if (cur && !cur.bot) throw new Error('Seat taken');
        if (me >= 0) r.seats[me] = null;
        r.seats[s] = { name, token };
        sys(r, `${name} sat in seat ${s + 1} (${TEAM_NAMES[s % 2]}).`);
      } else {
        if (me >= 0) throw new Error('You already have a seat');
        if (!cur || !(cur.bot || (cur.auto && !isConnected(r, cur.token)))) throw new Error('You can only take over a computer player mid-game');
        const was = cur.name;
        r.seats[s] = { name, token };
        sys(r, `${name} took over from ${was}.`);
      }
      break;
    }
    case 'stand': { if (g.status !== 'lobby' || me < 0) return; r.seats[me] = null; break; }
    case 'addBot': {
      const s = m.seat; if (![0, 1, 2, 3].includes(s) || r.seats[s]) return;
      const used = r.seats.filter(Boolean).map((x) => x.name);
      const nm = (BOT_NAMES.find((b) => !used.includes(b + ' 🤖')) || 'Bot') + ' 🤖';
      r.seats[s] = { name: nm, bot: true, token: null };
      sys(r, `${nm} (computer) joined seat ${s + 1}.`);
      break;
    }
    case 'removeBot': { const s = m.seat; if (g.status === 'lobby' && r.seats[s] && r.seats[s].bot) r.seats[s] = null; break; }
    case 'autopilot': {
      const s = m.seat; const cur = r.seats[s];
      if (!cur || cur.bot || g.status === 'lobby') return;
      if (isConnected(r, cur.token) && cur.token !== token) throw new Error(`${cur.name} is still connected`);
      cur.auto = !cur.auto;
      sys(r, cur.auto ? `The computer is playing for ${cur.name} until they're back.` : `${cur.name} is playing again.`);
      break;
    }
    case 'start': {
      if (g.status !== 'lobby') return;
      if (r.seats.some((s) => !s)) throw new Error('Fill all 4 seats (add computer players for empty seats)');
      if (me < 0) throw new Error('Take a seat first');
      sys(r, `Game on! ${TEAM_NAMES[0]}: ${teamLabel(r, 0)} vs ${TEAM_NAMES[1]}: ${teamLabel(r, 1)}. First to 500.`);
      startHand(r);
      break;
    }
    case 'next': { if (g.status === 'handover' && me >= 0) { clearTimeout(r.autoNext); startHand(r); } break; }
    case 'newGame': {
      if (g.status !== 'gameover' || me < 0) return;
      Object.assign(g, { status: 'lobby', hand: null, totals: [0, 0], history: [], handNo: 0, winner: null, gameNo: g.gameNo + 1 });
      sys(r, `New game. Swap seats if you like, then press Start.`);
      break;
    }
    case 'bid': case 'discard': case 'play': {
      if (me < 0) throw new Error('You are watching, not playing');
      act(r, me, m);
      break;
    }
    case 'chat': {
      const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!text || limited(r, token)) return;
      pushChat(r, { kind: 'chat', name: r.names[token] || 'Guest', seat: me, text });
      return save();
    }
    case 'react': {
      const ok = ['👍', '😂', '😮', '😡', '👏', '🔥', '🤦', '🍺'];
      if (!ok.includes(m.emoji) || limited(r, token)) return;
      pushChat(r, { kind: 'react', name: r.names[token] || 'Guest', seat: me, text: m.emoji });
      return save();
    }
    default: return;
  }
  broadcast(r); runBots(r);
}
function limited(r, token) {
  const now = Date.now(); const q = (r.rate[token] = (r.rate[token] || []).filter((t) => now - t < 5000));
  if (q.length >= 8) return true; q.push(now); return false;
}
function cleanName(n) { return String(n || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16); }
function send(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }

// ---------- http ----------
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => { res.set('Cache-Control', req.path.startsWith('/api') ? 'no-store' : 'no-cache'); next(); });
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));
app.post('/api/rooms', (req, res) => { const r = newRoom(req.body && req.body.fast); res.json({ code: r.code }); });
app.get('/api/rooms/:code', (req, res) => { const r = rooms.get(req.params.code.toUpperCase()); res.json({ exists: !!r }); });
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/[A-Za-z]{4}$/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    try { handle(ws, m); } catch (e) { send(ws, { t: 'error', msg: e.message }); }
  });
  ws.on('close', () => { if (ws.room) { ws.room.conns.delete(ws); broadcast(ws.room); } });
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000);

load();
for (const r of rooms.values()) { if (r.game.status === 'handover') { r.game.status = 'playing'; finishHandResume(r); } runBots(r); }
function finishHandResume(r) { r.game.status = 'handover'; r.autoNext = setTimeout(() => { if (r.game.status === 'handover') { startHand(r); broadcast(r); runBots(r); } }, 30000); }
server.listen(PORT, () => console.log('500 server on :' + PORT));
module.exports = { server };
