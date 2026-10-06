/**
 * Wall Race AI – pure algorithmic opponent (no LLM, no network).
 *
 * How a decision is made
 * ----------------------
 * 1. Score formula (evaluate):
 *      (opponent's shortest path − my shortest path) + tempo + wall-stock bonus
 *    Path lengths come from a breadth-first search that fills a distance table
 *    outward from the goal row: dist[cell] = 1 + min(dist[neighbour]). That is
 *    dynamic programming over the board.
 *
 * 2. Candidates: every legal pawn move (incl. jumps) plus a shortlist of wall
 *    slots on / around the opponent's shortest path. Moves and walls compete
 *    with the same score – a wall is chosen only when it beats stepping forward.
 *
 * 3. Look-ahead (negamax + alpha-beta): try a candidate on the board, recurse
 *    into the opponent's best reply, then UNDO it and try the next one. This
 *    make → recurse → undo loop is backtracking; alpha-beta prunes branches
 *    that provably cannot change the result.
 *
 * 4. Memoization (transposition table): positions are Zobrist-hashed and their
 *    search results cached, so a position reached by a different move order is
 *    never solved twice – dynamic programming over the game tree.
 *
 * 5. Iterative deepening: search depth 1, 2, 3 … until the level's depth or
 *    time budget is reached; the best move of each pass is tried first next pass.
 */

import { AI_LEVELS } from '../config.js';

const WIN = 10000;
const INF = 1e9;
const TEMPO = 0.5;        // having the move is worth about half a step
const WALL_WEIGHT = 0.3;  // value of one wall still in hand
const WALL_CAP = 10;      // walls beyond this are not worth more
const TIMEOUT = Symbol('timeout');

// Directions: 0 up, 1 down, 2 left, 3 right
const DR = [-1, 1, 0, 0];
const DC = [0, 0, -1, 1];
const PERP = [[2, 3], [2, 3], [0, 1], [0, 1]];

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const TT_MAX_ENTRIES = 300000;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ------------------------------------------------------------------ zobrist

/** Deterministic PRNG so hash tables are identical across runs. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const zobristCache = new Map();

/** Random keys for every pawn square, wall slot, wall count and side to move (two 32-bit halves). */
function zobristFor(n) {
  if (zobristCache.has(n)) return zobristCache.get(n);
  const rnd = mulberry32(0x5eed + n);
  const table = (len) => {
    const lo = new Uint32Array(len);
    const hi = new Uint32Array(len);
    for (let i = 0; i < len; i++) {
      lo[i] = rnd();
      hi[i] = rnd() & 0x1fffff; // 21 bits → combined key stays below 2^53
    }
    return { lo, hi };
  };
  const N = n * n;
  const z = {
    pawn: [table(N), table(N)],
    wall: table(2 * N),     // h slots then v slots
    stock: [table(64), table(64)],
    turn: table(1),
  };
  zobristCache.set(n, z);
  return z;
}

const stockIndex = (w) => (w === Infinity ? 63 : Math.min(w, 62));

// ------------------------------------------------------------- search state

/**
 * Compact, mutable board used by the search. Walls are flat byte arrays and
 * pawns are cell indices, so make / undo are O(1).
 *
 * Wall slot indexing (same meaning as GameModel):
 *   h[r*n + c] – horizontal wall above row r spanning column c   (1 ≤ r ≤ n-1)
 *   v[r*n + c] – vertical wall left of column c spanning row r    (1 ≤ c ≤ n-1)
 *
 * Action ids: 0..N-1 = move pawn to that cell; N + slot = place wall,
 * where slot < N is horizontal and slot ≥ N is vertical (slot - N).
 */
export class SearchState {
  constructor(game) {
    const n = game.size;
    const N = n * n;
    this.n = n;
    this.N = N;
    this.h = new Uint8Array(N);
    this.v = new Uint8Array(N);
    for (const w of game.walls) (w.o === 'h' ? this.h : this.v)[w.r * n + w.c] = 1;
    this.pos = game.pawns.map((p) => p.r * n + p.c);
    this.walls = game.wallsLeft.map((w) => (w === null ? Infinity : w));
    this.turn = game.turn;
    this.goal = [n - 1, 0];

    this.queue = new Int16Array(N);
    this.dist = [new Int16Array(N), new Int16Array(N)];
    this.mark = new Uint32Array(2 * N);
    this.markStamp = 0;

    this.z = zobristFor(n);
    this.#computeHash();
  }

  #computeHash() {
    const z = this.z;
    let lo = 0;
    let hi = 0;
    const xor = (t, i) => { lo ^= t.lo[i]; hi ^= t.hi[i]; };
    for (let p = 0; p < 2; p++) {
      xor(z.pawn[p], this.pos[p]);
      xor(z.stock[p], stockIndex(this.walls[p]));
    }
    for (let i = 0; i < this.N; i++) {
      if (this.h[i]) xor(z.wall, i);
      if (this.v[i]) xor(z.wall, this.N + i);
    }
    if (this.turn === 1) xor(z.turn, 0);
    this.hashLo = lo >>> 0;
    this.hashHi = hi;
  }

  #xor(t, i) {
    this.hashLo = (this.hashLo ^ t.lo[i]) >>> 0;
    this.hashHi ^= t.hi[i];
  }

  get key() {
    return this.hashHi * 4294967296 + this.hashLo;
  }

  row(cell) {
    return (cell / this.n) | 0;
  }

  hasWon(player) {
    return this.row(this.pos[player]) === this.goal[player];
  }

  /** Can a pawn on (r,c) step in direction d? (Walls and edges only; pawns ignored.) */
  canMove(r, c, d) {
    const n = this.n;
    switch (d) {
      case 0: return r > 0 && !this.h[r * n + c];
      case 1: return r < n - 1 && !this.h[(r + 1) * n + c];
      case 2: return c > 0 && !this.v[r * n + c];
      default: return c < n - 1 && !this.v[r * n + c + 1];
    }
  }

  /**
   * DP distance table: shortest number of steps from every cell to the
   * player's goal row (multi-source BFS from that row). -1 = unreachable.
   */
  fillDistances(player) {
    const n = this.n;
    const dist = this.dist[player];
    const q = this.queue;
    dist.fill(-1);
    let head = 0;
    let tail = 0;
    const g = this.goal[player] * n;
    for (let c = 0; c < n; c++) {
      dist[g + c] = 0;
      q[tail++] = g + c;
    }
    while (head < tail) {
      const cur = q[head++];
      const r = (cur / n) | 0;
      const c = cur - r * n;
      const d = dist[cur] + 1;
      for (let k = 0; k < 4; k++) {
        if (!this.canMove(r, c, k)) continue;
        const nb = cur + DR[k] * n + DC[k];
        if (dist[nb] < 0) {
          dist[nb] = d;
          q[tail++] = nb;
        }
      }
    }
    return dist;
  }

  /**
   * Score formula from the point of view of the side to move.
   * Returns NaN if a player has no path (position is illegal).
   */
  evaluate() {
    const p = this.turn;
    const o = 1 - p;
    const dP = this.fillDistances(p)[this.pos[p]];
    const dO = this.fillDistances(o)[this.pos[o]];
    if (dP < 0 || dO < 0) return NaN;
    const wallDiff = Math.min(this.walls[p], WALL_CAP) - Math.min(this.walls[o], WALL_CAP);
    return dO - dP + TEMPO + WALL_WEIGHT * wallDiff;
  }

  /** Legal pawn destinations (cell indices) for the side to move, with jump rules. */
  pawnMoves() {
    const n = this.n;
    const p = this.turn;
    const me = this.pos[p];
    const opp = this.pos[1 - p];
    const r = (me / n) | 0;
    const c = me - r * n;
    const out = [];
    for (let k = 0; k < 4; k++) {
      if (!this.canMove(r, c, k)) continue;
      const nb = me + DR[k] * n + DC[k];
      if (nb !== opp) {
        out.push(nb);
        continue;
      }
      const or = (opp / n) | 0;
      const oc = opp - or * n;
      if (this.canMove(or, oc, k)) {
        out.push(opp + DR[k] * n + DC[k]);
      } else {
        for (const s of PERP[k]) {
          if (this.canMove(or, oc, s)) out.push(opp + DR[s] * n + DC[s]);
        }
      }
    }
    return out;
  }

  /** Wall slot that blocks stepping from (r,c) in direction d (always an interior slot). */
  edgeSlot(r, c, d) {
    const n = this.n;
    switch (d) {
      case 0: return r * n + c;                    // h above
      case 1: return (r + 1) * n + c;              // h below
      case 2: return this.N + r * n + c;           // v left
      default: return this.N + r * n + c + 1;      // v right
    }
  }

  isFreeSlot(slot) {
    const n = this.n;
    if (slot < this.N) {
      const r = (slot / n) | 0;
      return r >= 1 && r <= n - 1 && !this.h[slot];
    }
    const s = slot - this.N;
    const c = s % n;
    return c >= 1 && c <= n - 1 && !this.v[s];
  }

  /**
   * Shortlist of wall slots that could slow `target` down: walls on the edges
   * of its shortest path (closest first), around its pawn and – if `spread` –
   * collinear extensions and flanks of those blocking spots.
   * Requires this.dist[target] to be filled for the current position.
   */
  wallCandidates(target, limit, spread) {
    const n = this.n;
    const dist = this.dist[target];
    const out = [];
    const stamp = ++this.markStamp;
    const add = (slot) => {
      if (out.length >= limit || slot < 0 || slot >= 2 * this.N) return;
      if (this.mark[slot] === stamp || !this.isFreeSlot(slot)) return;
      this.mark[slot] = stamp;
      out.push(slot);
    };
    const addExtensions = (r, c, d) => {
      // Same line, one segment to each side (lengthens a barrier) …
      if (d < 2) {
        const rr = d === 0 ? r : r + 1;
        if (c > 0) add(rr * n + c - 1);
        if (c < n - 1) add(rr * n + c + 1);
      } else {
        const cc = d === 2 ? c : c + 1;
        if (r > 0) add(this.N + (r - 1) * n + cc);
        if (r < n - 1) add(this.N + (r + 1) * n + cc);
      }
      // … and the two flanks of the cell (forms a pocket / funnel).
      for (const s of PERP[d]) if (this.canMove(r, c, s)) add(this.edgeSlot(r, c, s));
    };

    // Walk one shortest path from the pawn to the goal, following the DP table downhill.
    let cur = this.pos[target];
    const steps = [];
    while (dist[cur] > 0 && steps.length < this.N) {
      const r = (cur / n) | 0;
      const c = cur - r * n;
      let next = -1;
      let dir = -1;
      for (let k = 0; k < 4; k++) {
        if (!this.canMove(r, c, k)) continue;
        const nb = cur + DR[k] * n + DC[k];
        if (dist[nb] === dist[cur] - 1) { next = nb; dir = k; break; }
      }
      if (next < 0) break;
      steps.push([r, c, dir]);
      cur = next;
    }

    // Walls right around the pawn first, then along the path.
    const pr = (this.pos[target] / n) | 0;
    const pc = this.pos[target] - pr * n;
    for (const [r, c, d] of steps) {
      add(this.edgeSlot(r, c, d));
      if (r === pr && c === pc) for (let k = 0; k < 4; k++) if (this.canMove(r, c, k)) add(this.edgeSlot(r, c, k));
      if (spread) addExtensions(r, c, d);
    }
    return out;
  }

  // ------------------------------------------------------- make / undo

  /** Apply an action id; returns the info needed to undo it. */
  make(id) {
    const p = this.turn;
    let undo;
    if (id < this.N) {
      undo = this.pos[p];
      this.#xor(this.z.pawn[p], undo);
      this.pos[p] = id;
      this.#xor(this.z.pawn[p], id);
    } else {
      const slot = id - this.N;
      (slot < this.N ? this.h : this.v)[slot % this.N] = 1;
      this.#xor(this.z.wall, slot);
      this.#xor(this.z.stock[p], stockIndex(this.walls[p]));
      this.walls[p] -= 1;
      this.#xor(this.z.stock[p], stockIndex(this.walls[p]));
      undo = -1;
    }
    this.turn = 1 - p;
    this.#xor(this.z.turn, 0);
    return undo;
  }

  unmake(id, undo) {
    this.turn = 1 - this.turn;
    this.#xor(this.z.turn, 0);
    const p = this.turn;
    if (id < this.N) {
      this.#xor(this.z.pawn[p], this.pos[p]);
      this.pos[p] = undo;
      this.#xor(this.z.pawn[p], undo);
    } else {
      const slot = id - this.N;
      (slot < this.N ? this.h : this.v)[slot % this.N] = 0;
      this.#xor(this.z.wall, slot);
      this.#xor(this.z.stock[p], stockIndex(this.walls[p]));
      this.walls[p] += 1;
      this.#xor(this.z.stock[p], stockIndex(this.walls[p]));
    }
  }

  /** Convert an action id to the GameModel action format. */
  toAction(id) {
    const n = this.n;
    if (id < this.N) return { kind: 'move', r: (id / n) | 0, c: id % n };
    const slot = id - this.N;
    const o = slot < this.N ? 'h' : 'v';
    const s = slot % this.N;
    return { kind: 'wall', o, r: (s / n) | 0, c: s % n };
  }
}

// ------------------------------------------------------------------ search

class Searcher {
  constructor(state, level, deadline) {
    this.s = state;
    this.level = level;
    this.deadline = deadline;
    this.tt = new Map();
    this.nodes = 0;
  }

  /**
   * All candidate actions for the side to move, each with a static score
   * (side-to-move perspective) and ordered best-first. Illegal walls – those
   * that would cut a player off – are dropped here because their evaluation is NaN.
   */
  children(ply, preferred = -1) {
    const s = this.s;
    const p = s.turn;
    const o = 1 - p;
    const list = [];

    for (const cell of s.pawnMoves()) {
      const id = cell;
      const undo = s.make(id);
      const score = s.hasWon(p) ? WIN - (ply + 1) : -s.evaluate();
      s.unmake(id, undo);
      list.push({ id, score, wall: false });
    }

    if (s.walls[p] > 0) {
      s.fillDistances(o);
      const slots = s.wallCandidates(o, this.level.wallCandidates, this.level.wallSpread);
      for (const slot of slots) {
        const id = s.N + slot;
        const undo = s.make(id);
        const value = s.evaluate();
        s.unmake(id, undo);
        if (Number.isNaN(value)) continue; // would trap someone
        list.push({ id, score: -value, wall: true });
      }
    }

    list.sort((a, b) => b.score - a.score);
    if (preferred >= 0) {
      const i = list.findIndex((c) => c.id === preferred);
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
    }
    return list;
  }

  /** Negamax with alpha-beta pruning and a transposition table (memoization). */
  negamax(depth, alpha, beta, ply) {
    if ((++this.nodes & 255) === 0 && now() > this.deadline) throw TIMEOUT;

    const s = this.s;
    if (s.hasWon(1 - s.turn)) return -(WIN - ply); // previous mover already won
    if (depth === 0) return s.evaluate();

    const key = s.key;
    const entry = this.tt.get(key);
    let ttMove = -1;
    if (entry) {
      ttMove = entry.move;
      if (entry.depth >= depth) {
        if (entry.flag === TT_EXACT) return entry.value;
        if (entry.flag === TT_LOWER) alpha = Math.max(alpha, entry.value);
        else beta = Math.min(beta, entry.value);
        if (alpha >= beta) return entry.value;
      }
    }

    const alphaStart = alpha;
    const kids = this.children(ply, ttMove);
    let best = -INF;
    let bestMove = -1;

    for (const kid of kids) {
      let value;
      if (depth === 1 || kid.score >= WIN - 1000) {
        value = kid.score; // static score already computed while ordering
      } else {
        const undo = s.make(kid.id);
        try {
          value = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
        } finally {
          s.unmake(kid.id, undo); // backtrack
        }
      }
      if (value > best) {
        best = value;
        bestMove = kid.id;
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) break; // prune
    }

    if (this.tt.size < TT_MAX_ENTRIES) {
      const flag = best <= alphaStart ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
      this.tt.set(key, { depth, value: best, flag, move: bestMove });
    }
    return best;
  }

  /**
   * Scores every root candidate at the given depth. Levels with noise need
   * exact scores for all candidates, so they search each with a full window.
   */
  searchRoot(depth, preferred) {
    const s = this.s;
    const kids = this.children(0, preferred);
    const exactAll = this.level.noise > 0;
    let alpha = -INF;
    const scored = [];
    for (const kid of kids) {
      let value;
      if (depth === 1 || kid.score >= WIN - 1000) {
        value = kid.score;
      } else {
        const undo = s.make(kid.id);
        try {
          value = -this.negamax(depth - 1, -INF, exactAll ? INF : -alpha, 1);
        } finally {
          s.unmake(kid.id, undo);
        }
      }
      scored.push({ id: kid.id, wall: kid.wall, score: value });
      if (value > alpha) alpha = value;
    }
    return scored;
  }
}

// ---------------------------------------------------------------- public API

/**
 * Picks an action for `player` in the given position.
 * @param {object} game  GameModel.toJSON() output
 * @param {0|1} player   the AI's seat (must be the side to move)
 * @param {'easy'|'medium'|'hard'|object} difficulty level name, or a custom level object (tuning/tests)
 * @param {() => number} [random] RNG in [0,1) – injectable for tests
 * @returns {{action: object, depth: number, nodes: number, ms: number, score: number}}
 */
export function chooseAction(game, player, difficulty = 'medium', random = Math.random) {
  const level = typeof difficulty === 'object' ? difficulty : AI_LEVELS[difficulty] ?? AI_LEVELS.medium;
  const start = now();
  const state = new SearchState(game);
  if (state.turn !== player) throw new Error('It is not the AI\'s turn.');

  const searcher = new Searcher(state, level, start + level.timeMs);
  let scored = null;
  let depthReached = 0;
  let preferred = -1;

  // Iterative deepening: deeper passes reuse the TT and try the last best move first.
  for (let depth = 1; depth <= level.maxDepth; depth++) {
    try {
      const result = searcher.searchRoot(depth, preferred);
      if (!result.length) break;
      scored = result;
      depthReached = depth;
      preferred = result.reduce((a, b) => (b.score > a.score ? b : a)).id;
      if (result.some((r) => r.score >= WIN - 1000)) break; // forced win found
    } catch (err) {
      if (err !== TIMEOUT) throw err;
      break; // keep the last completed depth
    }
  }

  if (!scored || !scored.length) {
    // Should never happen (a pawn always has a move), but stay safe.
    const fallback = state.pawnMoves()[0];
    return { action: state.toAction(fallback), depth: 0, nodes: searcher.nodes, ms: now() - start, score: 0 };
  }

  // A winning move is always taken, whatever the level.
  const winning = scored.find((r) => r.score >= WIN - 1000);
  let pick = winning;
  if (!pick) {
    let bestValue = -INF;
    for (const r of scored) {
      const value = r.score + (r.wall ? level.wallBias : 0) + (random() * 2 - 1) * level.noise;
      if (value > bestValue) {
        bestValue = value;
        pick = r;
      }
    }
  }

  return {
    action: state.toAction(pick.id),
    depth: depthReached,
    nodes: searcher.nodes,
    ms: Math.round(now() - start),
    score: pick.score,
  };
}
