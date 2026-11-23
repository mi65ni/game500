'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');
const Bot = require('../bot');

const T = (cards) => cards.map((card, seat) => ({ seat, card }));

test('deck has 43 unique cards incl. red 4s and joker', () => {
  const d = G.newDeck();
  assert.equal(d.length, 43); assert.equal(new Set(d).size, 43);
  assert.ok(d.includes('4H') && d.includes('4D') && d.includes('JK'));
  assert.ok(!d.includes('4S') && !d.includes('4C'));
});

test('deal gives 10 each and a 3-card kitty', () => {
  const h = new G.Hand(0);
  assert.deepEqual(h.hands.map((x) => x.length), [10, 10, 10, 10]);
  assert.equal(h.kitty.length, 3);
  assert.equal(new Set([...h.hands.flat(), ...h.kitty]).size, 43);
  assert.equal(h.turn, 1);
});

test('bid values follow the Avondale schedule', () => {
  const v = (n, suit) => G.bidValue({ type: 'suit', n, suit });
  assert.equal(v(6, 'S'), 40); assert.equal(v(6, 'C'), 60); assert.equal(v(6, 'D'), 80); assert.equal(v(6, 'H'), 100); assert.equal(v(6, 'NT'), 120);
  assert.equal(v(7, 'S'), 140); assert.equal(v(8, 'H'), 300); assert.equal(v(9, 'NT'), 420); assert.equal(v(10, 'H'), 500); assert.equal(v(10, 'NT'), 520);
  assert.equal(G.bidValue({ type: 'mis' }), 250); assert.equal(G.bidValue({ type: 'omis' }), 500);
});

test('bid legality: must beat, misère needs a 7 bid first, open misère beats 10H', () => {
  assert.ok(G.canBid({ type: 'suit', n: 6, suit: 'S' }, null));
  assert.ok(!G.canBid({ type: 'suit', n: 6, suit: 'S' }, { type: 'suit', n: 6, suit: 'C' }));
  assert.ok(!G.canBid({ type: 'mis' }, null));
  assert.ok(!G.canBid({ type: 'mis' }, { type: 'suit', n: 6, suit: 'NT' }));
  assert.ok(G.canBid({ type: 'mis' }, { type: 'suit', n: 7, suit: 'S' }));
  assert.ok(G.canBid({ type: 'mis' }, { type: 'suit', n: 8, suit: 'S' }));
  assert.ok(!G.canBid({ type: 'mis' }, { type: 'suit', n: 8, suit: 'C' }));
  assert.ok(G.canBid({ type: 'omis' }, { type: 'suit', n: 10, suit: 'H' }));
  assert.ok(!G.canBid({ type: 'omis' }, { type: 'suit', n: 10, suit: 'NT' }));
  assert.ok(G.canBid({ type: 'suit', n: 10, suit: 'NT' }, { type: 'omis' }));
  assert.ok(!G.canBid({ type: 'suit', n: 11, suit: 'S' }, null));
  assert.ok(!G.canBid({ type: 'suit', n: 7, suit: 'X' }, null));
});

test('trick winner: bowers and joker in a suit contract', () => {
  // Hearts trumps. Right bower JH, left bower JD.
  assert.equal(G.trickWinner(T(['AS', 'KS', '5H', 'QS']), 'H'), 2, 'small trump beats ace led');
  assert.equal(G.trickWinner(T(['AH', 'JD', 'KH', '5H']), 'H'), 1, 'left bower beats ace of trumps');
  assert.equal(G.trickWinner(T(['JD', 'JH', 'AH', '5H']), 'H'), 1, 'right beats left');
  assert.equal(G.trickWinner(T(['JH', 'JK', 'JD', 'AH']), 'H'), 1, 'joker beats right bower');
  assert.equal(G.trickWinner(T(['10C', 'AC', 'AD', 'KC']), 'H'), 1, 'off-suit ace does not win');
  assert.equal(G.trickWinner(T(['10C', 'JS', 'QC', '9C']), 'H'), 2, 'JS is not trump when hearts trump');
  assert.equal(G.trickWinner(T(['10S', 'JC', 'AS', '9S']), 'S'), 1, 'left bower (JC) in spades');
  assert.equal(G.effSuit('JD', 'H'), 'H'); assert.equal(G.effSuit('JD', 'S'), 'D'); assert.equal(G.effSuit('JK', 'C'), 'C');
});

test('trick winner in no trumps & joker nomination', () => {
  assert.equal(G.trickWinner(T(['KS', 'AS', 'AH', 'QS']), 'NT'), 1);
  assert.equal(G.trickWinner(T(['KS', 'AS', 'JK', 'QS']), 'NT'), 2, 'joker wins in NT');
  assert.equal(G.trickWinner(T(['JK', 'AD', 'KD', '5D']), 'NT', 'D'), 0, 'led joker wins');
  assert.equal(G.trickWinner(T(['JD', 'QD', '5D', 'AH']), 'NT'), 1, 'jacks are normal in NT');
});

test('follow-suit legality', () => {
  const hand = ['JD', 'AS', '5D', 'JK', '9C'];
  // Hearts trumps: JD and JK are trumps; when hearts led, must play one of them
  assert.deepEqual(G.legalCards(hand, T(['AH']), 'H').sort(), ['JD', 'JK'].sort());
  // Diamonds led in hearts: JD is not a diamond any more -> only 5D
  assert.deepEqual(G.legalCards(hand, T(['KD']), 'H'), ['5D']);
  // NT, diamonds led: JD and 5D, joker not allowed while you can follow
  assert.deepEqual(G.legalCards(hand, T(['KD']), 'NT').sort(), ['5D', 'JD']);
  // NT, hearts led and void: anything incl. joker
  assert.equal(G.legalCards(hand, T(['KH']), 'NT').length, 5);
  // NT, joker led nominating clubs -> must follow clubs
  assert.deepEqual(G.legalCards(hand.filter((c) => c !== 'JK'), [{ seat: 0, card: 'JK' }], 'NT', 'C'), ['9C']);
  // leading: anything
  assert.equal(G.legalCards(hand, [], 'S').length, 5);
});

test('scoring: made, failed, slam bonus, misère', () => {
  const s7h = { type: 'suit', n: 7, suit: 'H' }; // 200
  assert.deepEqual(G.scoreHand(s7h, 0, [7, 3], 0), { delta: [200, 30], made: true });
  assert.deepEqual(G.scoreHand(s7h, 1, [4, 6], 0), { delta: [40, -200], made: false });
  assert.deepEqual(G.scoreHand(s7h, 0, [10, 0], 0), { delta: [250, 0], made: true }, 'slam on a <250 bid scores 250');
  const s8h = { type: 'suit', n: 8, suit: 'H' }; // 300
  assert.deepEqual(G.scoreHand(s8h, 0, [10, 0], 0), { delta: [300, 0], made: true }, 'slam on 300 bid keeps 300');
  assert.deepEqual(G.scoreHand({ type: 'mis' }, 1, [3, 0], 0), { delta: [0, 250], made: true });
  assert.deepEqual(G.scoreHand({ type: 'mis' }, 1, [3, 1], 1), { delta: [0, -250], made: false });
  assert.deepEqual(G.scoreHand({ type: 'omis' }, 0, [0, 2], 0), { delta: [500, 0], made: true });
});

test('game end rules', () => {
  // contractor makes bid and reaches 500 -> wins
  assert.equal(G.applyScores([380, 100], [140, 30], 0, true).winner, 0);
  // opponents reach 500 on tricks: capped at 490, no win
  let r = G.applyScores([480, 300], [40, -200], 1, false);
  assert.deepEqual(r.totals, [490, 100]); assert.equal(r.winner, null);
  // already above 490 stays put
  r = G.applyScores([495, 300], [30, -200], 1, false); assert.equal(r.totals[0], 495);
  // contractor goes to -500 -> loses
  r = G.applyScores([0, -400], [10, -140], 1, false); assert.equal(r.winner, 0);
  // making a bid but staying under 500 -> no winner
  assert.equal(G.applyScores([100, 100], [140, 30], 0, true).winner, null);
});

test('hand flow: bidding, all-pass redeal, kitty, misère partner sits out', () => {
  let h = new G.Hand(3);
  for (let i = 0; i < 4; i++) h.bid(h.turn, { type: 'pass' });
  assert.equal(h.phase, 'redeal');

  h = new G.Hand(3); // seat 0 bids first
  h.bid(0, { type: 'suit', n: 7, suit: 'S' });
  assert.throws(() => h.bid(1, { type: 'suit', n: 6, suit: 'H' }));
  h.bid(1, { type: 'mis' });
  h.bid(2, { type: 'pass' }); h.bid(3, { type: 'pass' });
  h.bid(0, { type: 'pass' });
  assert.equal(h.phase, 'kitty'); assert.equal(h.contractor, 1); assert.equal(h.sitOut, 3);
  assert.equal(h.hands[1].length, 13);
  assert.throws(() => h.discard(1, h.hands[1].slice(0, 2)));
  h.discard(1, h.hands[1].slice(0, 3));
  assert.equal(h.phase, 'playing'); assert.equal(h.turn, 1);
  // play with bots until finished; partner (3) must never be asked to play
  while (h.phase === 'playing') { assert.notEqual(h.turn, 3); const p = Bot.choosePlay(h, h.turn); h.play(h.turn, p.card, p.nominate); }
  assert.equal(h.phase, 'done');
  assert.equal(h.result.made, h.tricksWon[1] === 0);
});

test('illegal plays are rejected', () => {
  const deck = G.newDeck();
  const h = new G.Hand(3, Math.random, deck); // deterministic deal
  h.bid(0, { type: 'suit', n: 6, suit: 'S' }); h.bid(1, { type: 'pass' }); h.bid(2, { type: 'pass' }); h.bid(3, { type: 'pass' });
  h.discard(0, h.hands[0].slice(0, 3));
  assert.throws(() => h.play(1, h.hands[1][0]), /turn/);
  const lead = h.hands[0][0]; h.play(0, lead);
  const led = G.effSuit(lead, 'S');
  const bad = h.hands[1].find((c) => G.effSuit(c, 'S') !== led);
  if (h.hands[1].some((c) => G.effSuit(c, 'S') === led) && bad) assert.throws(() => h.play(1, bad), /follow/);
});

test('1000 random bot hands complete with consistent counts', () => {
  for (let i = 0; i < 1000; i++) {
    const h = new G.Hand(i % 4);
    while (h.phase === 'bidding') {
      const s = h.turn; h.bid(s, Bot.chooseBid(h.hands[s], h.high));
    }
    if (h.phase === 'redeal') continue;
    h.discard(h.contractor, Bot.chooseDiscard(h.hands[h.contractor], h.trump));
    while (h.phase === 'playing') { const p = Bot.choosePlay(h, h.turn); h.play(h.turn, p.card, p.nominate); }
    assert.equal(h.phase, 'done');
    if (h.contract.type === 'suit') assert.equal(h.tricksWon.reduce((a, b) => a + b), 10);
  }
});

test('joker led in NT requires nomination', () => {
  const h = new G.Hand(3);
  // force a hand: give seat 0 the joker
  const all = [...h.hands.flat(), ...h.kitty].filter((c) => c !== 'JK');
  h.hands = [['JK', ...all.slice(0, 9)], all.slice(9, 19), all.slice(19, 29), all.slice(29, 39)]; h.kitty = all.slice(39, 42);
  h.bid(0, { type: 'suit', n: 6, suit: 'NT' }); h.bid(1, { type: 'pass' }); h.bid(2, { type: 'pass' }); h.bid(3, { type: 'pass' });
  h.discard(0, h.hands[0].filter((c) => c !== 'JK').slice(0, 3));
  assert.throws(() => h.play(0, 'JK'), /Nominate/);
  h.play(0, 'JK', 'C');
  assert.equal(h.nominated, 'C');
  const p1 = h.legal(1); if (h.hands[1].some((c) => G.suitOf(c) === 'C')) assert.ok(p1.every((c) => G.suitOf(c) === 'C'));
});
