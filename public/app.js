'use strict';
(() => {
const $ = (id) => document.getElementById(id);
const SYM = { S: '♠', C: '♣', D: '♦', H: '♥' };
const RED = { D: 1, H: 1 };
const RV = { '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
const SAME = { S: 'C', C: 'S', D: 'H', H: 'D' };
const TEAM = ['Team A', 'Team B'];
const BASE = { S: 40, C: 60, D: 80, H: 100, NT: 120 };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let token = localStorage.getItem('t500_token');
if (!token) { token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('t500_token', token); }
let myName = localStorage.getItem('t500_name') || '';
let room = null, ws = null, S = null, selected = [], retry = 0, unread = 0, lastTrickShownUntil = 0, prevTrickCount = -1, prevHandNo = -1;
let chatOpen = false, lastOverlayKey = '';

const RULES_HTML = `<ul>
<li>4 players, partners sit opposite (Team A = seats 1 &amp; 3, Team B = seats 2 &amp; 4).</li>
<li>43-card deck: 5 to Ace in every suit, red 4s, plus the Joker. 10 cards each, 3 in the kitty.</li>
<li>Bidding goes round once you've passed you're out. Bids (Avondale): 6♠ 40, 6♣ 60, 6♦ 80, 6♥ 100, 6NT 120, each extra trick +100, up to 10NT 520. Misère 250 (only after someone bids 7+), Open Misère 500 (beats 10♥).</li>
<li>All pass = redeal. The winning bidder picks up the kitty and discards 3, then leads.</li>
<li>Trumps rank Joker, right bower (Jack of trumps), left bower (other Jack of the same colour), then A K Q 10 9 … The left bower counts as a trump.</li>
<li>No trumps: the Joker is the only trump. It can only be played if you can't follow suit; if you lead it, you name the suit to follow.</li>
<li>Misère: bidder plays alone (partner sits out), no trumps, must lose every trick. Open Misère: bidder's hand is shown after the first card.</li>
<li>Scoring: make your bid, score its value; fail, lose it. Opponents score 10 per trick (not in misère). All 10 tricks on a bid under 250 scores 250.</li>
<li>You can only win by making a bid that takes you to 500+. Opponents' trick points stop at 490. Fall to −500 and you lose.</li></ul>`;
$('rulesText').innerHTML = RULES_HTML;

// ---------- routing ----------
function codeFromUrl() {
  const m = location.pathname.match(/^\/([A-Za-z]{4})$/); if (m) return m[1].toUpperCase();
  const q = new URLSearchParams(location.search).get('r'); return q ? q.toUpperCase() : null;
}
$('nameInput').value = myName;
const initCode = codeFromUrl();
if (initCode) { $('codeInput').value = initCode; if (myName) enterRoom(initCode); else { $('createBtn').classList.add('hidden'); document.querySelector('.or').textContent = "You've been invited to game " + initCode + '. Enter your name and join.'; $('joinBtn').textContent = 'Join'; $('nameInput').focus(); } }

function needName() {
  const n = $('nameInput').value.trim().slice(0, 16);
  if (!n) { toast('Enter your name first'); $('nameInput').focus(); return null; }
  myName = n; localStorage.setItem('t500_name', n); return n;
}
$('createBtn').onclick = async () => {
  if (!needName()) return;
  const r = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
  history.replaceState(null, '', '/' + r.code);
  enterRoom(r.code, true);
};
$('joinBtn').onclick = async () => {
  if (!needName()) return;
  const c = $('codeInput').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(c)) return toast('Room codes are 4 letters');
  const r = await fetch('/api/rooms/' + c).then((r) => r.json());
  if (!r.exists) return toast('No game with code ' + c);
  history.replaceState(null, '', '/' + c);
  enterRoom(c);
};
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

function enterRoom(code, autoSit) {
  room = code; window._autoSit = autoSit;
  $('home').classList.add('hidden'); $('game').classList.remove('hidden');
  $('roomCode').textContent = code;
  connect();
}
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { retry = 0; $('conn').classList.add('hidden'); send({ t: 'hello', room, token, name: myName }); };
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  ws.onclose = () => { $('conn').classList.remove('hidden'); setTimeout(connect, Math.min(8000, 500 * 2 ** retry++)); };
}
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); else toast('Not connected, retrying…'); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && ws && ws.readyState > 1) connect(); });

function onMsg(m) {
  if (m.t === 'state') {
    const first = !S; S = m.state; window.__state = S;
    if (first && window._autoSit && S.me.seat < 0 && S.status === 'lobby') { window._autoSit = false; send({ t: 'sit', seat: 0 }); }
    render();
  } else if (m.t === 'chatlog') { $('chatLog').innerHTML = ''; m.msgs.forEach((x) => addMsg(x, true)); }
  else if (m.t === 'chat') addMsg(m.msg);
  else if (m.t === 'error') { toast(m.msg); if (m.fatal) { setTimeout(() => { location.href = '/'; }, 2000); } }
}

// ---------- cards ----------
const suitOf = (c) => (c === 'JK' ? null : c.slice(-1));
const rankOf = (c) => (c === 'JK' ? 'JK' : c.slice(0, -1));
function effSuit(c, trump) {
  if (c === 'JK') return SYM[trump] ? trump : 'JOKER';
  const r = rankOf(c), s = suitOf(c);
  if (SYM[trump] && r === 'J' && (s === trump || s === SAME[trump])) return trump;
  return s;
}
function cardHTML(c, cls = '') {
  if (c === 'JK') return `<div class="card joker ${cls}" data-c="JK"><div class="c1">JOKER</div><div class="mid">★</div></div>`;
  const s = suitOf(c), r = rankOf(c);
  return `<div class="card ${RED[s] ? 'red' : ''} ${cls}" data-c="${c}"><div class="c1">${r}<small>${SYM[s]}</small></div><div class="mid">${SYM[s]}</div></div>`;
}
function sortHand(hand, trump) {
  const tr = SYM[trump] ? trump : null;
  const order = tr ? ['S', 'H', 'C', 'D'].filter((s) => s !== tr) : ['S', 'H', 'C', 'D'];
  // keep colours alternating where possible, trumps on the right
  const key = (c) => {
    const es = effSuit(c, trump);
    if (c === 'JK') return 9999;
    if (tr && es === tr) { const r = rankOf(c); return 5000 + (r === 'J' ? (suitOf(c) === tr ? 99 : 98) : RV[r]); }
    return order.indexOf(es) * 100 + RV[rankOf(c)];
  };
  return hand.slice().sort((a, b) => key(a) - key(b));
}
const bidText = (b) => {
  if (!b) return ''; if (b.type === 'pass') return 'Pass'; if (b.type === 'mis') return 'Misère'; if (b.type === 'omis') return 'Open Misère';
  return b.n + (b.suit === 'NT' ? 'NT' : SYM[b.suit]);
};
const bidHTML = (b) => { const t = esc(bidText(b)); return b && b.type === 'suit' && RED[b.suit] ? `<span style="color:#e53935">${t}</span>` : t; };
const bidVal = (b) => (b.type === 'mis' ? 250 : b.type === 'omis' ? 500 : BASE[b.suit] + (b.n - 6) * 100);
const bidRank = (b) => (b && b.type === 'omis' ? 510 : b ? bidVal(b) : 0);

// ---------- render ----------
function rel(seat) { const me = S.me.seat >= 0 ? S.me.seat : 0; return (seat - me + 4) % 4; }
function render() {
  if (!S) return;
  $('roomCode').textContent = S.code;
  $('scoreMini').innerHTML = `<span class="t a">A ${S.totals[0]}</span><span class="t b">B ${S.totals[1]}</span>`;
  const lobby = S.status === 'lobby';
  $('lobby').classList.toggle('hidden', !lobby);
  $('felt').classList.toggle('hidden', lobby);
  if (lobby) { renderLobby(); $('hand').innerHTML = ''; $('actions').innerHTML = ''; closeOverlay(); return; }
  const h = S.hand;
  if (h) {
    if (S.handNo !== prevHandNo) { selected = []; prevHandNo = S.handNo; prevTrickCount = h.trickCount; }
    if (h.trickCount > prevTrickCount) { lastTrickShownUntil = Date.now() + 1900; setTimeout(render, 2000); }
    prevTrickCount = h.trickCount;
  }
  renderSeats(); renderCenter(); renderActions(); renderHand(); renderOverlay();
}
function shareLink() { return location.origin + '/' + S.code; }
function renderLobby() {
  const L = $('lobby');
  const seatBox = (i) => {
    const s = S.seats[i]; const mine = i === S.me.seat;
    let who = s ? `<div class="who">${esc(s.name)}${mine ? ' (you)' : ''}</div><div class="small">${s.bot ? 'Computer player' : s.connected ? 'Ready' : 'Offline'}</div>` : `<div class="small">Seat ${i + 1} · empty</div>`;
    let btns = '';
    if (!s) btns = `<button class="btn primary" data-a="sit" data-s="${i}">Sit here</button><button class="btn ghost" data-a="addBot" data-s="${i}">+ Computer</button>`;
    else if (s.bot) btns = `<button class="btn ghost" data-a="removeBot" data-s="${i}">Remove</button>`;
    else if (mine) btns = `<button class="btn ghost" data-a="stand">Stand up</button>`;
    return `<div class="slot">${who}<div class="btns">${btns}</div></div>`;
  };
  const full = S.seats.every(Boolean);
  L.innerHTML = `
  <div class="invite"><div class="small">Invite your mates. Room code</div><div class="code">${S.code}</div>
  <div class="link">${esc(shareLink())}</div>
  <button class="btn primary" id="shareBtn">Share invite link</button> <button class="btn ghost" id="copyBtn">Copy</button></div>
  <div class="teams">
   <div class="teamcol A"><h3>Team A</h3>${seatBox(0)}${seatBox(2)}</div>
   <div class="teamcol B"><h3>Team B</h3>${seatBox(1)}${seatBox(3)}</div>
  </div>
  <div class="small">Partners sit opposite each other. Fill empty seats with computer players if you're short.</div>
  <button class="btn primary big" id="startBtn" ${full && S.me.seat >= 0 ? '' : 'disabled'}>${full ? 'Start game' : 'Waiting for 4 players…'}</button>
  ${S.gameNo > 1 ? '' : ''}`;
  L.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => send({ t: b.dataset.a, seat: b.dataset.s !== undefined ? +b.dataset.s : undefined })));
  $('startBtn').onclick = () => send({ t: 'start' });
  $('shareBtn').onclick = share; $('copyBtn').onclick = copyLink;
}
async function share() {
  const data = { title: '500 card game', text: `Join my game of 500! Code ${S.code}`, url: shareLink() };
  if (navigator.share) { try { await navigator.share(data); } catch {} } else copyLink();
}
function copyLink() { navigator.clipboard.writeText(shareLink()).then(() => toast('Link copied'), () => prompt('Copy this link', shareLink())); }
$('codeChip').onclick = () => { if (S) share(); };

function renderSeats() {
  const h = S.hand;
  for (let i = 0; i < 4; i++) {
    const el = $('seat' + rel(i)); const s = S.seats[i];
    if (!s) { el.innerHTML = ''; continue; }
    el.className = `seat pos${rel(i)} team${i % 2 ? 'B' : 'A'}`;
    if (h && h.turn === i && ['bidding', 'kitty', 'playing'].includes(h.phase) && S.status === 'playing') el.classList.add('turn');
    if (h && h.sitOut === i) el.classList.add('out');
    const meta = [];
    if (S.dealer === i) meta.push('<span class="pill d">D</span>');
    if (!s.bot && !s.connected) meta.push(s.auto ? '<span class="pill">🤖 auto</span>' : '<span class="pill off">offline</span>');
    if (h && h.phase !== 'bidding' && h.sitOut !== i) meta.push(`<span class="pill">${h.tricksWon[i]} tr</span>`);
    let tag = '';
    if (h && h.phase === 'bidding') {
      const last = [...h.bids].reverse().find((b) => b.seat === i);
      if (last) tag = `<div class="bidtag ${last.bid.type === 'pass' ? 'pass' : ''}">${bidHTML(last.bid)}</div>`;
    } else if (h && h.contractor === i) tag = `<div class="bidtag">${bidHTML(h.contract)}</div>`;
    const backs = rel(i) !== 0 && h ? `<div class="minibacks">${'<i></i>'.repeat(Math.min(h.counts[i], 13))}</div>` : '';
    let extra = '';
    if (!s.bot && !s.connected && S.me.seat >= 0 && S.me.seat !== i) extra = `<div><button class="btn ghost" style="padding:2px 6px;font-size:11px;margin-top:3px" data-auto="${i}">${s.auto ? 'Stop bot' : 'Bot plays'}</button></div>`;
    if (S.me.seat < 0 && (s.bot || (s.auto && !s.connected))) extra = `<div><button class="btn primary" style="padding:2px 6px;font-size:11px;margin-top:3px" data-take="${i}">Take seat</button></div>`;
    el.innerHTML = `<div class="nm">${esc(s.name)}${i === S.me.seat ? ' (you)' : ''}</div><div class="meta">${meta.join('')}</div>${tag}${rel(i) !== 0 ? backs : ''}${extra}`;
    el.querySelectorAll('[data-auto]').forEach((b) => (b.onclick = () => send({ t: 'autopilot', seat: +b.dataset.auto })));
    el.querySelectorAll('[data-take]').forEach((b) => (b.onclick = () => send({ t: 'sit', seat: +b.dataset.take })));
  }
}
function renderCenter() {
  const h = S.hand; const C = $('contract'), T = $('trick'), O = $('openHand');
  if (!h) { C.innerHTML = ''; T.innerHTML = ''; return; }
  if (h.contract) {
    const ct = h.contractor % 2;
    const isMis = h.contract.type !== 'suit';
    C.innerHTML = `<b>${esc(S.seats[h.contractor].name)}</b> · ${bidHTML(h.contract)} · ` + (isMis ? `needs 0 tricks (has ${h.tricksWon[h.contractor]})` : `${TEAM[ct]} ${h.teamTricks[ct]}/${h.contract.n}, ${TEAM[1 - ct]} ${h.teamTricks[1 - ct]}`);
  } else if (h.phase === 'bidding') C.innerHTML = h.high ? `Highest bid: <b>${bidHTML(h.high)}</b> by ${esc(S.seats[h.highSeat].name)}` : 'Bidding…';
  let cards = h.trick, winner = null, nom = h.nominated, label = '';
  if (!cards.length && h.lastTrick && (Date.now() < lastTrickShownUntil || h.phase === 'done')) {
    cards = h.lastTrick.cards; winner = h.lastTrick.winner; nom = h.lastTrick.nominated; label = `${esc(S.seats[winner].name)} wins the trick`;
  }
  T.innerHTML = cards.map((p) => cardHTML(p.card, 'p' + rel(p.seat) + (p.seat === winner ? ' win' : ''))).join('') +
    (nom ? `<div class="nomtag">Joker led, ${SYM[nom]} to follow</div>` : '') + (label ? `<div class="lbl">${label}</div>` : '');
  if (h.openHand && h.contractor !== S.me.seat) { O.classList.remove('hidden'); O.innerHTML = `<div class="small" style="width:100%;text-align:center">${esc(S.seats[h.contractor].name)}'s open hand</div>` + sortHand(h.openHand, 'NT').map((c) => cardHTML(c)).join(''); }
  else O.classList.add('hidden');
}
function renderActions() {
  const A = $('actions'); const h = S.hand; const me = S.me.seat;
  if (!h || S.status !== 'playing') { A.innerHTML = ''; return; }
  if (me < 0) { A.innerHTML = `<div class="hint">You're watching. ${S.seats.some((s) => s && s.bot) ? 'Tap "Take seat" on a computer player to join in.' : ''}</div>`; return; }
  const myTurn = h.turn === me;
  if (h.phase === 'bidding') {
    if (!myTurn) { A.innerHTML = `<div class="hint">Waiting for ${esc(S.seats[h.turn].name)} to bid…</div>`; return; }
    const hi = h.high;
    const can = (b) => b.type === 'mis' ? (hi && bidVal(hi) >= 140 && 250 > bidRank(hi)) : bidRank(b) > bidRank(hi);
    let g = '<div class="lv"></div>' + ['S', 'C', 'D', 'H', 'NT'].map((s) => `<div class="lv">${s === 'NT' ? 'NT' : `<span style="${RED[s] ? 'color:#ff6b6b' : ''}">${SYM[s]}</span>`}</div>`).join('');
    for (let n = 6; n <= 10; n++) {
      g += `<div class="lv">${n}</div>`;
      for (const s of ['S', 'C', 'D', 'H', 'NT']) { const b = { type: 'suit', n, suit: s }; g += `<button class="${RED[s] ? 'r' : ''}" ${can(b) ? '' : 'disabled'} data-bid='${JSON.stringify(b)}'>${n}${s === 'NT' ? 'NT' : SYM[s]}<span class="val">${bidVal(b)}</span></button>`; }
    }
    g += `<button class="wide pass" data-bid='{"type":"pass"}'>Pass</button><button class="wide" ${can({ type: 'mis' }) ? '' : 'disabled'} data-bid='{"type":"mis"}'>Misère<span class="val">250</span></button><button class="wide" ${can({ type: 'omis' }) ? '' : 'disabled'} data-bid='{"type":"omis"}'>Open Mis<span class="val">500</span></button>`;
    A.innerHTML = `<div class="hint go">Your bid${hi ? ` (beat ${esc(bidText(hi))})` : ''}</div><div class="bidgrid">${g}</div>`;
    A.querySelectorAll('[data-bid]').forEach((b) => (b.onclick = () => {
      const bid = JSON.parse(b.dataset.bid);
      if (bid.type !== 'pass' && bidVal(bid) >= 300 && !confirm(`Bid ${bidText(bid)} for ${bidVal(bid)}?`)) return;
      send({ t: 'bid', bid });
    }));
    return;
  }
  if (h.phase === 'kitty') {
    if (!myTurn) { A.innerHTML = `<div class="hint">${esc(S.seats[h.turn].name)} is picking up the kitty…</div>`; return; }
    A.innerHTML = `<div class="hint go">You won with ${esc(bidText(h.contract))}. Tap 3 cards to discard (${selected.length}/3)</div><button class="btn primary" id="discardBtn" ${selected.length === 3 ? '' : 'disabled'}>Discard these 3</button>`;
    $('discardBtn').onclick = () => { send({ t: 'discard', cards: selected }); selected = []; };
    return;
  }
  if (h.phase === 'playing') {
    if (h.sitOut === me) { A.innerHTML = `<div class="hint">Your partner is playing misère alone. You sit this hand out.</div>`; return; }
    A.innerHTML = myTurn ? `<div class="hint go">Your turn. Tap a card, tap again to play</div>` : `<div class="hint">${esc(S.seats[h.turn].name)} to play…</div>`;
    return;
  }
  A.innerHTML = '';
}
function renderHand() {
  const H = $('hand'); const h = S.hand; const me = S.me.seat;
  if (!h || me < 0) { H.innerHTML = ''; return; }
  const trump = h.contract ? h.trump : null;
  const cards = sortHand(h.myHand, trump);
  const legal = new Set(h.legal);
  const playing = h.phase === 'playing' && h.turn === me;
  const kitty = h.phase === 'kitty' && h.turn === me;
  selected = selected.filter((c) => h.myHand.includes(c));
  H.innerHTML = cards.map((c) => {
    let cls = '';
    if (playing) cls += legal.has(c) ? ' legal' : ' dim';
    if (selected.includes(c)) cls += ' sel';
    if (trump && SYM[trump] && effSuit(c, trump) === trump) cls += ' trumpc';
    return cardHTML(c, cls);
  }).join('');
  // overlap to fit width
  const cw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cw')) || 58;
  const avail = H.clientWidth - 16; const n = cards.length;
  const ov = n > 1 ? Math.min(4, (avail - n * cw) / (n - 1)) : 0;
  H.querySelectorAll('.card').forEach((el, i) => { if (i) el.style.marginLeft = ov + 'px'; });
  H.querySelectorAll('.card').forEach((el) => (el.onclick = () => {
    const c = el.dataset.c;
    if (kitty) { if (selected.includes(c)) selected = selected.filter((x) => x !== c); else if (selected.length < 3) selected.push(c); renderActions(); renderHand(); return; }
    if (!playing) return;
    if (!legal.has(c)) return toast('You must follow suit');
    if (selected[0] === c) { playCard(c); selected = []; } else { selected = [c]; renderHand(); }
  }));
}
function playCard(c) {
  const h = S.hand;
  if (c === 'JK' && !h.trick.length && !SYM[h.trump]) {
    openModal(`<h2>Joker lead</h2><p>Name the suit everyone must follow</p><div class="suitpick">${['S', 'H', 'C', 'D'].map((s) => `<button class="${RED[s] ? 'r' : ''}" data-n="${s}">${SYM[s]}</button>`).join('')}</div><div class="btns"><button class="btn ghost" id="mc">Cancel</button></div>`);
    $('modal').querySelectorAll('[data-n]').forEach((b) => (b.onclick = () => { closeOverlay(); send({ t: 'play', card: 'JK', nominate: b.dataset.n }); }));
    $('mc').onclick = closeOverlay;
    return;
  }
  send({ t: 'play', card: c });
}
function renderOverlay() {
  const h = S.hand;
  if (S.status === 'handover' || S.status === 'gameover') {
    const key = S.status + S.handNo;
    if (lastOverlayKey === key) return;
    const delay = Date.now() < lastTrickShownUntil ? lastTrickShownUntil - Date.now() : 0;
    setTimeout(() => {
      if (!S || S.status !== (key.startsWith('gameover') ? 'gameover' : 'handover') || lastOverlayKey === key) return;
      lastOverlayKey = key;
      const last = S.history[S.history.length - 1];
      const hh = S.hand;
      let body = last ? `<p><b>${esc(last.bidder)}</b> ${last.made ? 'made' : 'went down in'} <b>${esc(last.contract)}</b>${hh && hh.contract.type === 'suit' ? ` with ${last.tricks[last.team]} tricks` : ''}.</p>
        <div class="big2"><div><span class="small">Team A</span><b style="color:var(--teamA)">${S.totals[0]}</b><span>${fmt(last.delta[0])}</span></div><div><span class="small">Team B</span><b style="color:var(--teamB)">${S.totals[1]}</b><span>${fmt(last.delta[1])}</span></div></div>` : '';
      if (hh && hh.kitty) body += `<div class="small">Kitty was ${hh.kitty.map((c) => c === 'JK' ? 'Joker' : rankOf(c) + SYM[suitOf(c)]).join(' ')}</div>`;
      if (S.status === 'gameover') {
        const iw = S.me.seat >= 0 && S.me.seat % 2 === S.winner;
        openModal(`<h2>${iw ? '🏆 You win!' : '🏆 ' + TEAM[S.winner] + ' win!'}</h2><p>${esc(S.teams[S.winner])}</p>${body}<div class="btns"><button class="btn primary" id="ng">New game</button><button class="btn ghost" id="sc">Scores</button><button class="btn ghost" id="cl">Close</button></div>`);
        $('ng').onclick = () => { closeOverlay(); send({ t: 'newGame' }); };
      } else {
        openModal(`<h2>Hand ${S.handNo} result</h2>${body}<div class="btns"><button class="btn primary" id="nx">Next hand</button><button class="btn ghost" id="sc">Scores</button></div><div class="small" style="margin-top:8px">Next hand starts by itself in 30 seconds</div>`);
        $('nx').onclick = () => { closeOverlay(); send({ t: 'next' }); };
      }
      $('sc').onclick = () => { closeOverlay(); showScores(); };
      const cl = $('cl'); if (cl) cl.onclick = closeOverlay;
    }, delay);
  } else if (lastOverlayKey && !lastOverlayKey.startsWith('modal')) { closeOverlay(); lastOverlayKey = ''; }
}
const fmt = (n) => (n > 0 ? '+' + n : '' + n);
function openModal(html) { $('modal').innerHTML = html; $('overlay').classList.remove('hidden'); }
function closeOverlay() { $('overlay').classList.add('hidden'); }

function showScores() {
  if (!S) return;
  const rows = S.history.map((r) => `<tr><td>${r.hand}</td><td class="l">${esc(r.bidder)} <span style="color:${r.team ? 'var(--teamB)' : 'var(--teamA)'}">(${r.team ? 'B' : 'A'})</span><br><small>${esc(r.contract)} ${r.made ? '✅' : '❌'}</small></td><td>${r.tricks[0]}–${r.tricks[1]}</td><td>${fmt(r.delta[0])}</td><td>${fmt(r.delta[1])}</td><td><b>${r.totals[0]}</b></td><td><b>${r.totals[1]}</b></td></tr>`).join('');
  $('sheetBody').innerHTML = `<h2 style="margin-top:0">Scores · Game ${S.gameNo}</h2>
  <div class="big2"><div><span class="small" style="color:var(--teamA)">Team A</span><b>${S.totals[0]}</b><span class="small">${esc(S.teams[0])}</span></div><div><span class="small" style="color:var(--teamB)">Team B</span><b>${S.totals[1]}</b><span class="small">${esc(S.teams[1])}</span></div></div>
  ${rows ? `<table><tr><th>#</th><th class="l">Bid</th><th>Tricks A–B</th><th>A</th><th>B</th><th>A tot</th><th>B tot</th></tr>${rows}</table>` : '<p class="small">No hands played yet.</p>'}
  <details class="rules" style="margin-top:12px"><summary>Rules &amp; bid values</summary>${RULES_HTML}</details>
  <div class="btns" style="margin-top:12px;text-align:center"><button class="btn primary" id="closeSheet">Close</button></div>`;
  $('sheet').classList.remove('hidden');
  $('closeSheet').onclick = () => $('sheet').classList.add('hidden');
}
$('scoresBtn').onclick = showScores;
$('sheet').onclick = (e) => { if (e.target.id === 'sheet') $('sheet').classList.add('hidden'); };

// ---------- chat ----------
const REACTS = ['👍', '😂', '😮', '😡', '👏', '🔥', '🤦', '🍺'];
$('reacts').innerHTML = REACTS.map((e) => `<button data-e="${e}">${e}</button>`).join('');
$('reacts').querySelectorAll('button').forEach((b) => (b.onclick = () => send({ t: 'react', emoji: b.dataset.e })));
$('chatForm').onsubmit = (e) => { e.preventDefault(); const v = $('chatInput').value.trim(); if (!v) return; send({ t: 'chat', text: v }); $('chatInput').value = ''; };
$('chatBtn').onclick = () => { chatOpen = true; $('chat').classList.add('open'); unread = 0; badge(); setTimeout(() => { const l = $('chatLog'); l.scrollTop = l.scrollHeight; }, 50); };
$('chatClose').onclick = () => { chatOpen = false; $('chat').classList.remove('open'); };
function badge() { const b = $('chatBadge'); b.textContent = unread; b.classList.toggle('hidden', !unread); }
function addMsg(m, quiet) {
  const L = $('chatLog');
  const near = L.scrollHeight - L.scrollTop - L.clientHeight < 80;
  const d = document.createElement('div');
  const tm = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const team = m.seat >= 0 ? (m.seat % 2 ? 'B' : 'A') : '';
  const mine = S && m.seat === S.me.seat && m.seat >= 0 && m.name === S.seats[m.seat]?.name;
  if (m.kind === 'sys') { d.className = 'msg sys'; d.textContent = m.text; }
  else { d.className = `msg ${team} ${mine ? 'mine' : ''} ${m.kind === 'react' ? 'react' : ''}`; d.innerHTML = `<div><span class="who">${esc(m.name)}</span><span class="tm">${tm}</span></div>${m.kind === 'react' ? `<span class="em">${esc(m.text)}</span>` : esc(m.text)}`; }
  L.appendChild(d);
  if (near || quiet || mine) L.scrollTop = L.scrollHeight;
  if (quiet || m.kind === 'sys') return;
  const mobile = matchMedia('(max-width:900px)').matches;
  if (mobile && !chatOpen) { unread++; badge(); }
  if (S && m.seat >= 0 && S.status !== 'lobby') {
    const el = $('seat' + rel(m.seat));
    if (m.kind === 'react') { const r = el.getBoundingClientRect(); const f = document.createElement('div'); f.className = 'floater'; f.textContent = m.text; f.style.left = r.left + r.width / 2 + 'px'; f.style.top = r.top + 'px'; $('floaters').appendChild(f); setTimeout(() => f.remove(), 2300); }
    else { el.querySelectorAll('.bubble').forEach((b) => b.remove()); const b = document.createElement('div'); b.className = 'bubble'; b.textContent = m.text; el.appendChild(b); setTimeout(() => b.remove(), 4000); }
  }
}

let toastT;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2600); }
window.addEventListener('resize', () => S && renderHand());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
let wasMyTurn = false;
setInterval(() => { if (!S || !S.hand) return; const mt = S.hand.turn === S.me.seat && S.status === 'playing'; if (mt && !wasMyTurn && navigator.vibrate) navigator.vibrate(60); wasMyTurn = mt; }, 500);
})();
