'use strict';
// Simple computer player for 500.
const G = require('./game');
const { JOKER, SUITS, effSuit, power, trickWinner, ledSuitOf, rankOf, suitOf, RANK_VAL } = G;

function handStrength(hand, trump) {
  let t = 0;
  const trumps = hand.filter((c) => effSuit(c, trump) === trump);
  for (const c of trumps) {
    const p = power(c, trump, trump);
    if (p >= 998) t += 1; else if (p >= 513) t += 0.75; else t += 0.45;
  }
  if (trumps.length >= 5) t += 0.5;
  for (const c of hand) {
    if (effSuit(c, trump) === trump) continue;
    if (rankOf(c) === 'A') t += 0.8; else if (rankOf(c) === 'K') t += 0.3;
  }
  return t;
}
function ntStrength(hand) {
  let t = hand.includes(JOKER) ? 1 : 0;
  for (const c of hand) { const r = rankOf(c); if (r === 'A') t += 1; else if (r === 'K') t += 0.5; else if (r === 'Q') t += 0.2; }
  return t;
}
function chooseBid(hand, high, partnerBid) {
  let best = null;
  for (const s of SUITS) {
    const est = handStrength(hand, s) + 2.2 + (partnerBid && partnerBid.type === 'suit' && partnerBid.suit === s ? 1 : 0);
    const maxN = Math.min(10, Math.floor(est));
    if (maxN >= 6) for (let n = 6; n <= maxN; n++) { const b = { type: 'suit', n, suit: s }; if (G.canBid(b, high)) { if (!best || maxN > best.max) best = { bid: b, max: maxN }; break; } }
  }
  const nt = ntStrength(hand) + 2;
  const ntMax = Math.min(10, Math.floor(nt));
  if (ntMax >= 7) for (let n = 6; n <= ntMax; n++) { const b = { type: 'suit', n, suit: 'NT' }; if (G.canBid(b, high)) { if (!best || ntMax > best.max) best = { bid: b, max: ntMax }; break; } }
  return best ? best.bid : { type: 'pass' };
}
function chooseDiscard(hand, trump) {
  const misere = trump === 'MIS';
  const score = (c) => {
    if (misere) return -(c === JOKER ? 100 : RANK_VAL[rankOf(c)]); // dump high cards
    if (effSuit(c, trump) === trump) return 1000 + power(c, trump, trump);
    if (c === JOKER) return 2000;
    const r = RANK_VAL[rankOf(c)];
    const len = hand.filter((x) => effSuit(x, trump) === effSuit(c, trump)).length;
    return r * 10 - len * 3 + (r === 14 ? 200 : 0);
  };
  return hand.slice().sort((a, b) => score(a) - score(b)).slice(0, 3);
}
function lowCard(cards, trump, led) { return cards.slice().sort((a, b) => cmpVal(a, trump, led) - cmpVal(b, trump, led))[0]; }
function highCard(cards, trump, led) { return cards.slice().sort((a, b) => cmpVal(b, trump, led) - cmpVal(a, trump, led))[0]; }
function cmpVal(c, trump, led) {
  const p = power(c, trump, led || effSuit(c, trump));
  return p === 0 ? (c === JOKER ? 1000 : RANK_VAL[rankOf(c)] / 100) : p;
}
function bestNominate(hand) {
  const cnt = {}; for (const s of SUITS) cnt[s] = hand.filter((c) => suitOf(c) === s).length;
  return SUITS.slice().sort((a, b) => cnt[b] - cnt[a])[0];
}
// Returns {card, nominate}
function choosePlay(h, seat) {
  const legal = h.legal(seat);
  const trump = h.trump;
  const trick = h.trick;
  const misere = h.contract.type !== 'suit';
  const iAmBidder = seat === h.contractor;
  const myTeam = seat % 2, ct = h.contractor % 2;
  if (misere && iAmBidder) {
    if (!trick.length) { const c = lowCard(legal.filter((c) => c !== JOKER).length ? legal.filter((c) => c !== JOKER) : legal, trump); return { card: c, nominate: c === JOKER ? bestNominate(h.hands[seat]) : undefined }; }
    const losers = legal.filter((c) => trickWinner([...trick, { seat, card: c }], trump, h.nominated) !== seat);
    if (losers.length) return { card: highCard(losers, trump, ledSuitOf(trick, trump, h.nominated)) };
    return { card: lowCard(legal, trump, ledSuitOf(trick, trump, h.nominated)) };
  }
  if (misere) { // defenders: try to force the bidder to win; lead low, follow low
    const c = lowCard(legal, trump, ledSuitOf(trick, trump, h.nominated));
    return { card: c, nominate: c === JOKER ? bestNominate(h.hands[seat]) : undefined };
  }
  if (!trick.length) {
    const trumps = legal.filter((c) => effSuit(c, trump) === trump);
    if (myTeam === ct && trumps.length && G.SUITS.includes(trump)) return { card: highCard(trumps, trump, trump) };
    const aces = legal.filter((c) => rankOf(c) === 'A' && effSuit(c, trump) !== trump);
    if (aces.length) return { card: aces[0] };
    const nonJ = legal.filter((c) => c !== JOKER);
    const c = lowCard(nonJ.length ? nonJ : legal, trump);
    return { card: c, nominate: c === JOKER ? bestNominate(h.hands[seat]) : undefined };
  }
  const led = ledSuitOf(trick, trump, h.nominated);
  const cur = trickWinner(trick, trump, h.nominated);
  const need = h.sitOut === null ? 4 : 3;
  const last = trick.length === need - 1;
  const partnerWinning = cur % 2 === myTeam;
  if (partnerWinning && (last || power(trick.find((p) => p.seat === cur).card, trump, led) >= 513)) return { card: lowCard(legal, trump, led) };
  const winners = legal.filter((c) => trickWinner([...trick, { seat, card: c }], trump, h.nominated) === seat);
  if (winners.length && !(partnerWinning)) return { card: lowCard(winners, trump, led) };
  return { card: lowCard(legal, trump, led) };
}
module.exports = { chooseBid, chooseDiscard, choosePlay, bestNominate };
