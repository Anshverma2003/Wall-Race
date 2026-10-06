/**
 * Pure game-rules model. No DOM, no networking – fully serialisable so the
 * host can broadcast it and either side can persist it to localStorage.
 *
 * Coordinates
 * -----------
 *  Cells:  (r, c) with 0 <= r, c < size. Row 0 is the top edge.
 *  Player 0 (P1) starts top-centre and must reach the bottom row.
 *  Player 1 (P2) starts bottom-centre and must reach the top row.
 *
 *  Walls are one segment long (between two adjacent dots):
 *   - { o: 'h', r, c }  horizontal, on the grid line above row r, spanning column c
 *                       (blocks movement between (r-1, c) and (r, c)); 1 <= r <= size-1
 *   - { o: 'v', r, c }  vertical, on the grid line left of column c, spanning row r
 *                       (blocks movement between (r, c-1) and (r, c)); 1 <= c <= size-1
 *  Walls on the outer border would be meaningless, so they are not allowed.
 */

export const DIRECTIONS = Object.freeze([
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]);

export const GameStatus = Object.freeze({
  PLAYING: 'playing',
  FINISHED: 'finished',
});

const wallKey = (o, r, c) => `${o}:${r}:${c}`;

export class GameModel {
  /**
   * @param {{size:number, wallLimit:number|null, startingPlayer:0|1}} options
   */
  constructor({ size, wallLimit, startingPlayer = 0 }) {
    if (size % 2 === 0) throw new Error('Grid size must be odd.');
    const mid = (size - 1) / 2;

    this.size = size;
    this.wallLimit = wallLimit; // null = unlimited
    this.pawns = [
      { r: 0, c: mid },
      { r: size - 1, c: mid },
    ];
    this.wallsLeft = [wallLimit, wallLimit];
    /** @type {{o:'h'|'v', r:number, c:number, by:0|1}[]} */
    this.walls = [];
    this.turn = startingPlayer;
    this.startingPlayer = startingPlayer;
    this.status = GameStatus.PLAYING;
    this.winner = null;
    this.moveCount = 0;
    /** @type {null | {by:0|1, kind:'move'|'wall', r:number, c:number, o?:'h'|'v', jumped?:boolean}} */
    this.lastAction = null;

    this._wallSet = new Set();
  }

  // ----------------------------------------------------------- serialisation

  toJSON() {
    return {
      size: this.size,
      wallLimit: this.wallLimit,
      pawns: this.pawns.map((p) => ({ ...p })),
      wallsLeft: [...this.wallsLeft],
      walls: this.walls.map((w) => ({ ...w })),
      turn: this.turn,
      startingPlayer: this.startingPlayer,
      status: this.status,
      winner: this.winner,
      moveCount: this.moveCount,
      lastAction: this.lastAction ? { ...this.lastAction } : null,
    };
  }

  static fromJSON(data) {
    const game = new GameModel({ size: data.size, wallLimit: data.wallLimit, startingPlayer: data.startingPlayer });
    game.pawns = data.pawns.map((p) => ({ r: p.r, c: p.c }));
    game.wallsLeft = [...data.wallsLeft];
    game.walls = data.walls.map((w) => ({ o: w.o, r: w.r, c: w.c, by: w.by }));
    game.turn = data.turn;
    game.status = data.status;
    game.winner = data.winner;
    game.moveCount = data.moveCount;
    game.lastAction = data.lastAction ? { ...data.lastAction } : null;
    game._wallSet = new Set(game.walls.map((w) => wallKey(w.o, w.r, w.c)));
    return game;
  }

  // ----------------------------------------------------------------- queries

  get isOver() {
    return this.status === GameStatus.FINISHED;
  }

  goalRow(player) {
    return player === 0 ? this.size - 1 : 0;
  }

  inBounds(r, c) {
    return r >= 0 && c >= 0 && r < this.size && c < this.size;
  }

  hasWall(o, r, c) {
    return this._wallSet.has(wallKey(o, r, c));
  }

  /** True if a wall sits between orthogonally adjacent cells. */
  isBlocked(r, c, nr, nc) {
    if (nr === r + 1) return this.hasWall('h', r + 1, c);
    if (nr === r - 1) return this.hasWall('h', r, c);
    if (nc === c + 1) return this.hasWall('v', r, c + 1);
    if (nc === c - 1) return this.hasWall('v', r, c);
    return true;
  }

  /** Can a pawn step from (r,c) one square in direction (dr,dc)? Ignores pawns. */
  canStep(r, c, dr, dc) {
    const nr = r + dr;
    const nc = c + dc;
    return this.inBounds(nr, nc) && !this.isBlocked(r, c, nr, nc);
  }

  hasWallsLeft(player) {
    return this.wallsLeft[player] === null || this.wallsLeft[player] > 0;
  }

  /**
   * Legal destination squares for a player, including Quoridor jumps:
   *  - straight jump over an adjacent opponent if nothing blocks behind them;
   *  - otherwise a diagonal side-step next to the opponent.
   * @returns {{r:number, c:number, jumped:boolean}[]}
   */
  getLegalMoves(player) {
    const me = this.pawns[player];
    const opp = this.pawns[1 - player];
    const moves = [];

    for (const [dr, dc] of DIRECTIONS) {
      if (!this.canStep(me.r, me.c, dr, dc)) continue;
      const nr = me.r + dr;
      const nc = me.c + dc;

      if (nr !== opp.r || nc !== opp.c) {
        moves.push({ r: nr, c: nc, jumped: false });
        continue;
      }

      if (this.canStep(opp.r, opp.c, dr, dc)) {
        moves.push({ r: opp.r + dr, c: opp.c + dc, jumped: true });
        continue;
      }

      // Wall or board edge behind the opponent → side-steps.
      const sides = dr !== 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
      for (const [sr, sc] of sides) {
        if (this.canStep(opp.r, opp.c, sr, sc)) {
          moves.push({ r: opp.r + sr, c: opp.c + sc, jumped: true });
        }
      }
    }
    return moves;
  }

  isValidWallSlot(o, r, c) {
    const n = this.size;
    if (o === 'h') return Number.isInteger(r) && Number.isInteger(c) && r >= 1 && r <= n - 1 && c >= 0 && c <= n - 1;
    if (o === 'v') return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r <= n - 1 && c >= 1 && c <= n - 1;
    return false;
  }

  /** Breadth-first search: does the player still have any route to their goal row? Pawns are ignored. */
  hasPathToGoal(player) {
    const start = this.pawns[player];
    const goal = this.goalRow(player);
    const seen = new Uint8Array(this.size * this.size);
    const queue = [start.r * this.size + start.c];
    seen[queue[0]] = 1;

    for (let i = 0; i < queue.length; i++) {
      const r = Math.floor(queue[i] / this.size);
      const c = queue[i] % this.size;
      if (r === goal) return true;
      for (const [dr, dc] of DIRECTIONS) {
        if (!this.canStep(r, c, dr, dc)) continue;
        const idx = (r + dr) * this.size + (c + dc);
        if (seen[idx]) continue;
        seen[idx] = 1;
        queue.push(idx);
      }
    }
    return false;
  }

  /**
   * Validates a wall for a player (does not check whose turn it is).
   * @returns {{ok:true} | {ok:false, reason:string}}
   */
  checkWall(player, { o, r, c }) {
    if (!this.hasWallsLeft(player)) return { ok: false, reason: 'You have no walls left.' };
    if (!this.isValidWallSlot(o, r, c)) return { ok: false, reason: 'Walls can only be placed between two dots inside the board.' };
    if (this.hasWall(o, r, c)) return { ok: false, reason: 'There is already a wall there.' };

    const key = wallKey(o, r, c);
    this._wallSet.add(key);
    const blocksP1 = !this.hasPathToGoal(0);
    const blocksP2 = !this.hasPathToGoal(1);
    this._wallSet.delete(key);

    if (blocksP1 || blocksP2) {
      const who = blocksP1 && blocksP2 ? 'both players' : player === (blocksP1 ? 0 : 1) ? 'you' : 'your opponent';
      return { ok: false, reason: `That wall would leave ${who} with no way to the other side.` };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- mutation

  /**
   * Applies a move or wall for a player, enforcing turn order and all rules.
   * @param {0|1} player
   * @param {{kind:'move', r:number, c:number} | {kind:'wall', o:'h'|'v', r:number, c:number}} action
   * @returns {{ok:true} | {ok:false, reason:string}}
   */
  applyAction(player, action) {
    if (this.isOver) return { ok: false, reason: 'The game is over.' };
    if (player !== this.turn) return { ok: false, reason: "It's not your turn." };
    if (!action || typeof action !== 'object') return { ok: false, reason: 'Invalid action.' };

    if (action.kind === 'move') {
      const move = this.getLegalMoves(player).find((m) => m.r === action.r && m.c === action.c);
      if (!move) return { ok: false, reason: "You can't move there." };

      this.pawns[player] = { r: move.r, c: move.c };
      this.lastAction = { by: player, kind: 'move', r: move.r, c: move.c, jumped: move.jumped };

      if (move.r === this.goalRow(player)) {
        this.status = GameStatus.FINISHED;
        this.winner = player;
      }
    } else if (action.kind === 'wall') {
      const wall = { o: action.o, r: action.r, c: action.c };
      const check = this.checkWall(player, wall);
      if (!check.ok) return check;

      this.walls.push({ ...wall, by: player });
      this._wallSet.add(wallKey(wall.o, wall.r, wall.c));
      if (this.wallsLeft[player] !== null) this.wallsLeft[player] -= 1;
      this.lastAction = { by: player, kind: 'wall', ...wall };
    } else {
      return { ok: false, reason: 'Unknown action.' };
    }

    this.moveCount += 1;
    if (!this.isOver) this.turn = 1 - player;
    return { ok: true };
  }
}
