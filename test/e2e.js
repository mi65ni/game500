'use strict';
// End-to-end: 4 websocket players play a full game through the given URL, chat, reconnect.
// Then 1 human + 3 computer players play a full game. Usage: node test/e2e.js https://xxx.trycloudflare.com
const WebSocket = require('ws');
const assert = require('assert/strict');
const BASE = process.argv[2] || 'http://localhost:8500';
const WSURL = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

class Client {
  constructor(name, code, token) { this.name = name; this.code = code; this.token = token || 'tok_' + name + '_' + Math.random().toString(36).slice(2); this.chat = []; this.errors = []; this.S = null; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(WSURL);
      this.ws.on('open', () => { this.send({ t: 'hello', room: this.code, token: this.token, name: this.name }); });
      this.ws.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.t === 'state') { const first = !this.S; this.S = m.state; if (first) res(); this.onState && this.onState(); }
        else if (m.t === 'chat') this.chat.push(m.msg);
        else if (m.t === 'chatlog') this.chat = m.msgs.slice();
        else if (m.t === 'error') this.errors.push(m.msg);
      });
      this.ws.on('error', rej);
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  close() { this.ws.close(); this.S = null; }
}
const G = require('../game');
// decide an action for a human client from its view only
function decide(c) {
  const S = c.S; if (!S || S.status !== 'playing' || !S.hand) return null;
  const h = S.hand, me = S.me.seat;
  if (h.turn !== me) return null;
  if (h.phase === 'bidding') {
    // seat 0/2 bid aggressively to make games end; others mostly pass
    if (!h.high && (me % 2 === 0 || Math.random() < 0.3)) return { t: 'bid', bid: { type: 'suit', n: 7, suit: ['S', 'C', 'D', 'H'][Math.floor(Math.random() * 4)] } };
    if (h.high && !global.misDone && Math.random() < 0.3 && G.canBid({ type: 'mis' }, h.high)) { global.misDone = true; return { t: 'bid', bid: { type: 'mis' } }; }
    return { t: 'bid', bid: { type: 'pass' } };
  }
  if (h.phase === 'kitty') return { t: 'discard', cards: h.myHand.slice(0, 3) };
  if (h.phase === 'playing') {
    const card = h.legal[Math.floor(Math.random() * h.legal.length)];
    return { t: 'play', card, nominate: card === 'JK' && !['S', 'C', 'D', 'H'].includes(h.trump) ? 'H' : undefined };
  }
}
async function createRoom(fast) {
  const r = await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fast }) });
  return (await r.json()).code;
}
async function waitFor(fn, ms = 20000, what = 'condition') {
  const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(20); }
}

async function fourHumans() {
  // static assets reachable through the URL
  for (const p of ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icon-192.png']) { const r = await fetch(BASE + p); assert.equal(r.status, 200, p); }
  const code = await createRoom(false);
  log('room', code);
  const cs = ['Nathan', 'Dave', 'Shane', 'Kylie'].map((n) => new Client(n, code));
  for (const c of cs) await c.connect();
  cs.forEach((c, i) => c.send({ t: 'sit', seat: i }));
  await waitFor(() => cs.every((c) => c.S.seats.every(Boolean)), 10000, 'seats');
  // chat + reaction
  cs[0].send({ t: 'chat', text: 'G\'day lads, deal em <b>up</b>' });
  cs[2].send({ t: 'react', emoji: '🍺' });
  await waitFor(() => cs.every((c) => c.chat.some((m) => m.kind === 'chat' && m.text.includes('deal em')) && c.chat.some((m) => m.kind === 'react' && m.text === '🍺')), 10000, 'chat');
  log('chat delivered to all 4');
  cs[1].send({ t: 'start' });
  await waitFor(() => cs.every((c) => c.S.status === 'playing'), 10000, 'start');
  let actions = 0, reconnected = false, illegalTried = false, hands = 0;
  const t0 = Date.now();
  while (true) {
    const S0 = cs[0].S;
    if (S0 && S0.status === 'gameover') break;
    if (Date.now() - t0 > 600000) throw new Error('game took too long');
    if (S0 && S0.status === 'handover') { hands = S0.handNo; cs[3].send({ t: 'next' }); await waitFor(() => cs[0].S.status !== 'handover', 10000, 'next hand'); continue; }
    // privacy check: nobody sees other hands
    for (const c of cs) if (c.S && c.S.hand) assert.ok(c.S.hand.myHand.length === c.S.hand.counts[c.S.me.seat]);
    // reconnect test mid-hand
    if (!reconnected && S0 && S0.hand && S0.hand.phase === 'playing' && S0.hand.trickCount === 3) {
      const old = cs[2]; const handBefore = old.S.hand.myHand.slice().sort().join();
      old.close(); await sleep(300);
      await waitFor(() => !cs[0].S.seats[2].connected, 60000, 'offline flag');
      const nc = new Client('Shane', code, old.token); await nc.connect(); cs[2] = nc;
      assert.equal(nc.S.me.seat, 2, 'kept seat after reconnect');
      assert.equal(nc.S.hand.myHand.slice().sort().join(), handBefore, 'kept hand after reconnect');
      reconnected = true; log('reconnect kept seat and hand');
    }
    let acted = false;
    for (const c of cs) {
      const a = decide(c);
      if (!a) continue;
      if (!illegalTried && a.t === 'play' && c.S.hand.trick.length) {
        const bad = c.S.hand.myHand.find((x) => !c.S.hand.legal.includes(x));
        if (bad) { const n = c.errors.length; c.send({ t: 'play', card: bad }); await waitFor(() => c.errors.length > n, 5000, 'illegal rejection'); assert.match(c.errors[c.errors.length - 1], /follow suit/); illegalTried = true; log('illegal card rejected:', c.errors[c.errors.length - 1]); }
      }
      const before = JSON.stringify(c.S.hand && [c.S.hand.phase, c.S.hand.turn, c.S.hand.trickCount, c.S.hand.trick.length, c.S.handNo, c.S.hand.bids.length]);
      c.send(a); actions++; acted = true;
      await waitFor(() => JSON.stringify(cs[0].S.hand && [cs[0].S.hand.phase, cs[0].S.hand.turn, cs[0].S.hand.trickCount, cs[0].S.hand.trick.length, cs[0].S.handNo, cs[0].S.hand.bids.length]) !== before || cs[0].S.status !== 'playing', 10000, 'state change after ' + a.t);
      break;
    }
    if (!acted) await sleep(30);
  }
  const S = cs[0].S;
  assert.ok(S.history.some((r) => !/Mis/.test(r.contract)), 'played at least one suit contract');
  assert.ok(S.history.every((r) => /Mis/.test(r.contract) || r.tricks[0] + r.tricks[1] === 10), 'suit hands have 10 tricks');
  log(S.history.map((r) => `#${r.hand} ${r.bidder} ${r.contract} ${r.made ? 'made' : 'down'} tricks ${r.tricks.join('-')} => ${r.delta.join('/')} = ${r.totals.join('/')}`).join('\n'));
  log(`4-human game over after ${S.handNo} hands, ${actions} actions. Final ${S.totals[0]}–${S.totals[1]}, winner Team ${'AB'[S.winner]}`);
  // verify score history sums
  let t = [0, 0]; for (const r of S.history) { t = [t[0] + r.delta[0], t[1] + r.delta[1]]; assert.deepEqual(t, r.totals); }
  const last = S.history[S.history.length - 1];
  assert.ok((S.totals[S.winner] >= 500 && last.made && last.team === S.winner) || S.totals[1 - S.winner] <= -500, 'valid game end');
  assert.ok(cs.every((c) => c.S.status === 'gameover' && c.S.winner === S.winner), 'all clients agree');
  const sysCount = cs[0].chat.filter((m) => m.kind === 'sys').length; assert.ok(sysCount > 10, 'system messages logged');
  assert.ok(cs[1].chat.some((m) => m.text.includes('&lt;') || m.text.includes('<b>')), 'chat text delivered raw (client escapes)');
  // new game resets
  cs[0].send({ t: 'newGame' }); await waitFor(() => cs[1].S.status === 'lobby' && cs[1].S.totals[0] === 0, 5000, 'new game');
  log('new game reset ok; history rows:', S.history.length, 'system msgs:', sysCount);
  cs.forEach((c) => c.close());
}

async function withBots() {
  const code = await createRoom(true);
  const me = new Client('Nathan', code); global.lastClient = me; await me.connect();
  me.send({ t: 'sit', seat: 0 }); for (const s of [1, 2, 3]) me.send({ t: 'addBot', seat: s });
  await waitFor(() => me.S.seats.every(Boolean), 5000, 'bots seated');
  assert.ok(me.S.seats[1].bot);
  me.send({ t: 'start' });
  const t0 = Date.now();
  while (me.S.status !== 'gameover') {
    if (Date.now() - t0 > 600000) throw new Error('bot game too slow');
    const a = decide(me); if (a) { const k = JSON.stringify([me.S.hand.phase, me.S.hand.turn, me.S.hand.trickCount, me.S.hand.trick.length, me.S.handNo, me.S.hand.bids.length]); me.send(a); global.lastAction = a; global.lastKey = k; await waitFor(() => JSON.stringify(me.S.hand && [me.S.hand.phase, me.S.hand.turn, me.S.hand.trickCount, me.S.hand.trick.length, me.S.handNo, me.S.hand.bids.length]) !== k || me.S.status !== 'playing', 10000, 'my action'); }
    else await sleep(20);
  }
  log(`1 human + 3 bots: game over after ${me.S.handNo} hands. ${me.S.totals[0]}–${me.S.totals[1]}, Team ${'AB'[me.S.winner]} won`);
  // autopilot: start a new game, disconnect, let another (spectator) switch the seat to bot
  me.send({ t: 'newGame' }); await waitFor(() => me.S.status === 'lobby', 5000, 'lobby'); me.send({ t: 'start' });
  await waitFor(() => me.S.status === 'playing', 5000, 'restart');
  const spect = new Client('Watcher', code); await spect.connect();
  assert.equal(spect.S.me.seat, -1);
  spect.send({ t: 'sit', seat: 1 }); await waitFor(() => spect.S.me.seat === 1, 5000, 'take over bot');
  log('spectator took over a computer seat mid-game');
  me.close(); await waitFor(() => !spect.S.seats[0].connected, 60000, 'me offline');
  spect.send({ t: 'autopilot', seat: 0 }); await waitFor(() => spect.S.seats[0].auto, 5000, 'autopilot');
  log('autopilot enabled for an offline player');
  spect.close();
}

(async () => {
  await fourHumans();
  await withBots();
  log('ALL E2E CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  const c = global.lastClient; const h = c && c.S && c.S.hand;
  console.error('E2E FAILED', e.message, 'lastAction', JSON.stringify(global.lastAction), 'key', global.lastKey, 'errors', c && c.errors, 'state', h && JSON.stringify({ status: c.S.status, phase: h.phase, turn: h.turn, tc: h.trickCount, trick: h.trick, high: h.high, legal: h.legal, handNo: c.S.handNo }));
  process.exit(1);
});
