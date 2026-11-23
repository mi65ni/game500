'use strict';
// Pure rules engine for 500 (Australian 4-player, Avondale schedule).
const SUITS = ['S', 'C', 'D', 'H'];
const SUIT_BASE = { S: 40, C: 60, D: 80, H: 100, NT: 120 };
const RANK_VAL = { '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
const JOKER = 'JK';
const SAME_COLOUR = { S: 'C', C: 'S', D: 'H', H: 'D' };

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of ['5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']) d.push(r + s);
  d.push('4D', '4H', JOKER);
  return d; // 43 cards
}
function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function rankOf(c) { return c === JOKER ? 'JK' : c.slice(0, -1); }
function suitOf(c) { return c === JOKER ? null : c.slice(-1); }
const isTrumpSuit = (t) => SUITS.includes(t);

// Effective suit of a card given trump ('S','C','D','H','NT', or 'MIS' for misère = no trumps)
function effSuit(c, trump) {
  if (c === JOKER) return isTrumpSuit(trump) ? trump : 'JOKER';
  const r = rankOf(c), s = suitOf(c);
  if (isTrumpSuit(trump) && r === 'J' && (s === trump || s === SAME_COLOUR[trump])) return trump;
  return s;
}
// Power within a trick. ledSuit is the effective suit that must be followed.
function power(c, trump, ledSuit) {
  if (c === JOKER) return 1000;
  const es = effSuit(c, trump);
  if (isTrumpSuit(trump) && es === trump) {
    const r = rankOf(c), s = suitOf(c);
    if (r === 'J' && s === trump) return 999; // right bower
    if (r === 'J') return 998; // left bower
    return 500 + RANK_VAL[r];
  }
  if (es === ledSuit) return RANK_VAL[rankOf(c)];
  return 0;
}
// trick: [{seat, card}], nominated: suit nominated when joker led in NT/misère
function ledSuitOf(trick, trump, nominated) {
  if (!trick.length) return null;
  const first = trick[0].card;
  if (first === JOKER && !isTrumpSuit(trump)) return nominated || null;
  return effSuit(first, trump);
}
function trickWinner(trick, trump, nominated) {
  const led = ledSuitOf(trick, trump, nominated);
  let best = null, bp = -1;
  for (const p of trick) { const pw = power(p.card, trump, led); if (pw > bp) { bp = pw; best = p.seat; } }
  return best;
}
function legalCards(hand, trick, trump, nominated) {
  if (!trick.length) return hand.slice();
  const led = ledSuitOf(trick, trump, nominated);
  const follow = hand.filter((c) => effSuit(c, trump) === led);
  return follow.length ? follow : hand.slice();
}

// ---- Bids ----
// {type:'pass'} | {type:'suit', n:6..10, suit:'S'|'C'|'D'|'H'|'NT'} | {type:'mis'} | {type:'omis'}
function bidValue(b) {
  if (!b || b.type === 'pass') return 0;
  if (b.type === 'mis') return 250;
  if (b.type === 'omis') return 500;
  return SUIT_BASE[b.suit] + (b.n - 6) * 100;
}
// Ordering key (open misère outranks 10 hearts even though both score 500)
function bidRank(b) { return b && b.type === 'omis' ? 510 : bidValue(b); }
function validBidShape(b) {
  if (!b || typeof b !== 'object') return false;
  if (['pass', 'mis', 'omis'].includes(b.type)) return true;
  return b.type === 'suit' && Number.isInteger(b.n) && b.n >= 6 && b.n <= 10 && (SUITS.includes(b.suit) || b.suit === 'NT');
}
// Misère may only be bid once somebody has bid seven or more. Open misère any time.
function canBid(b, high) {
  if (!validBidShape(b)) return false;
  if (b.type === 'pass') return true;
  if (b.type === 'mis' && (!high || bidValue(high) < 140)) return false;
  return bidRank(b) > (high ? bidRank(high) : 0);
}
function bidLabel(b) {
  if (!b) return '';
  if (b.type === 'pass') return 'Pass';
  if (b.type === 'mis') return 'Misère';
  if (b.type === 'omis') return 'Open Misère';
  const sym = { S: '♠', C: '♣', D: '♦', H: '♥', NT: 'NT' }[b.suit];
  return b.n + ' ' + (b.suit === 'NT' ? 'No Trumps' : sym);
}
function trumpOf(b) { return b.type === 'suit' ? b.suit : 'MIS'; }
const teamOf = (seat) => seat % 2;

// tricks: [teamA, teamB] tricks won; bidderTricks used for misère
function scoreHand(contract, contractTeam, tricks, bidderTricks) {
  const v = bidValue(contract);
  const delta = [0, 0];
  const opp = 1 - contractTeam;
  let made;
  if (contract.type === 'mis' || contract.type === 'omis') {
    made = bidderTricks === 0;
    delta[contractTeam] = made ? v : -v;
  } else {
    made = tricks[contractTeam] >= contract.n;
    if (made) delta[contractTeam] = (tricks[contractTeam] === 10 && v < 250) ? 250 : v;
    else delta[contractTeam] = -v;
    delta[opp] = 10 * tricks[opp];
  }
  return { delta, made };
}
// Win only by making a bid that takes you to 500+. Opponents' trick points cap at 490.
// A team that falls to -500 or below loses.
function applyScores(totals, delta, contractTeam, made) {
  const t = [totals[0] + delta[0], totals[1] + delta[1]];
  const opp = 1 - contractTeam;
  if (t[opp] >= 500) t[opp] = Math.max(totals[opp], 490);
  let winner = null;
  if (made && t[contractTeam] >= 500) winner = contractTeam;
  else if (t[contractTeam] <= -500) winner = opp;
  else if (t[opp] <= -500) winner = contractTeam;
  return { totals: t, winner };
}

// ---- Hand state machine ----
class Hand {
  constructor(dealer, rnd = Math.random, deck) {
    this.dealer = dealer;
    const d = deck || shuffle(newDeck(), rnd);
    this.hands = [[], [], [], []];
    // deal 10 each (3-4-3 style doesn't matter for randomness), kitty 3
    for (let i = 0; i < 40; i++) this.hands[(dealer + 1 + i) % 4].push(d[i]);
    this.kitty = d.slice(40, 43);
    this.phase = 'bidding';
    this.turn = (dealer + 1) % 4;
    this.passed = [false, false, false, false];
    this.bids = []; // {seat, bid}
    this.high = null; this.highSeat = null;
    this.contract = null; this.contractor = null;
    this.trick = []; this.nominated = null;
    this.lastTrick = null;
    this.tricksWon = [0, 0, 0, 0];
    this.trickCount = 0;
    this.sitOut = null; // partner of misère bidder
    this.result = null;
    this.discards = null;
  }
  get trump() { return this.contract ? trumpOf(this.contract) : null; }
  active(seat) { return seat !== this.sitOut; }
  nextSeat(s) { let n = (s + 1) % 4; while (!this.active(n)) n = (n + 1) % 4; return n; }

  bid(seat, b) {
    if (this.phase !== 'bidding') throw new Error('Not bidding now');
    if (seat !== this.turn) throw new Error('Not your turn');
    if (!canBid(b, this.high)) throw new Error('That bid is not allowed');
    this.bids.push({ seat, bid: b });
    if (b.type === 'pass') this.passed[seat] = true;
    else { this.high = b; this.highSeat = seat; }
    const remaining = [0, 1, 2, 3].filter((s) => !this.passed[s]);
    if (remaining.length === 0) { this.phase = 'redeal'; return { redeal: true }; }
    if (remaining.length === 1 && this.highSeat === remaining[0]) { this._award(); return { won: true }; }
    let n = (seat + 1) % 4; while (this.passed[n]) n = (n + 1) % 4;
    this.turn = n;
    return {};
  }
  _award() {
    this.contract = this.high; this.contractor = this.highSeat;
    if (this.contract.type === 'mis' || this.contract.type === 'omis') this.sitOut = (this.contractor + 2) % 4;
    this.hands[this.contractor].push(...this.kitty);
    this.phase = 'kitty';
    this.turn = this.contractor;
  }
  discard(seat, cards) {
    if (this.phase !== 'kitty') throw new Error('Not discarding now');
    if (seat !== this.contractor) throw new Error('Only the contractor discards');
    if (!Array.isArray(cards) || cards.length !== 3 || new Set(cards).size !== 3) throw new Error('Pick exactly 3 cards');
    const h = this.hands[seat];
    for (const c of cards) if (!h.includes(c)) throw new Error('You do not hold ' + c);
    this.hands[seat] = h.filter((c) => !cards.includes(c));
    this.discards = cards.slice();
    this.phase = 'playing';
    this.turn = this.contractor;
    return {};
  }
  legal(seat) {
    if (this.phase !== 'playing' || seat !== this.turn) return [];
    return legalCards(this.hands[seat], this.trick, this.trump, this.nominated);
  }
  play(seat, card, nominate) {
    if (this.phase !== 'playing') throw new Error('Not playing now');
    if (seat !== this.turn) throw new Error('Not your turn');
    if (!this.hands[seat].includes(card)) throw new Error('You do not hold that card');
    if (!this.legal(seat).includes(card)) throw new Error('You must follow suit');
    if (this.trick.length === 0) {
      this.nominated = null;
      if (card === JOKER && !isTrumpSuit(this.trump)) {
        if (!SUITS.includes(nominate)) throw new Error('Nominate a suit for the Joker');
        this.nominated = nominate;
      }
    }
    this.hands[seat] = this.hands[seat].filter((c) => c !== card);
    this.trick.push({ seat, card });
    const need = this.sitOut === null ? 4 : 3;
    if (this.trick.length < need) { this.turn = this.nextSeat(seat); return {}; }
    const w = trickWinner(this.trick, this.trump, this.nominated);
    this.tricksWon[w]++; this.trickCount++;
    this.lastTrick = { cards: this.trick, winner: w, nominated: this.nominated };
    this.trick = []; this.nominated = null;
    this.turn = w;
    const mis = this.contract.type !== 'suit';
    if (this.trickCount === 10 || (mis && w === this.contractor)) this._finish();
    return { trickWinner: w };
  }
  teamTricks() { return [this.tricksWon[0] + this.tricksWon[2], this.tricksWon[1] + this.tricksWon[3]]; }
  _finish() {
    const ct = teamOf(this.contractor);
    const r = scoreHand(this.contract, ct, this.teamTricks(), this.tricksWon[this.contractor]);
    this.result = { ...r, contractTeam: ct, tricks: this.teamTricks() };
    this.phase = 'done';
  }
}

module.exports = {
  SUITS, JOKER, newDeck, shuffle, rankOf, suitOf, effSuit, power, trickWinner, legalCards, ledSuitOf,
  bidValue, bidRank, canBid, bidLabel, validBidShape, trumpOf, teamOf, scoreHand, applyScores, Hand, RANK_VAL,
};
