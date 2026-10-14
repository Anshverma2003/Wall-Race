/**
 * Chess clock for an online game: each player has their own time and only
 * the clock of the player to move runs. No bonus time per move.
 *
 * The host owns the real clock. It sends `snapshot()` with every sync and
 * the guest rebuilds a local copy with `ClockModel.fromSnapshot()`, which
 * keeps counting down from the moment the snapshot arrived (no reliance on
 * the two devices' system clocks agreeing).
 */
export class ClockModel {
  /** @type {[number, number]} milliseconds left for P1 and P2 at `#since` */
  remaining;
  /** Whose clock is running (0 | 1), or null when stopped / paused. */
  running = null;
  #since = 0;
  #now;

  /**
   * @param {{limitMs:number, remaining?:[number,number], now?:() => number}} options
   */
  constructor({ limitMs, remaining, now = () => performance.now() }) {
    this.limitMs = limitMs;
    this.remaining = remaining ? [...remaining] : [limitMs, limitMs];
    this.#now = now;
  }

  /** Time left for a player right now, never below 0. */
  left(player) {
    const spent = player === this.running ? this.#now() - this.#since : 0;
    return Math.max(0, this.remaining[player] - spent);
  }

  /** Milliseconds until the running player's flag falls (Infinity when stopped). */
  get msToTimeout() {
    return this.running === null ? Infinity : this.left(this.running);
  }

  get isRunning() {
    return this.running !== null;
  }

  /** Start (or switch) the clock to `player`; null stops it. Charges the time used so far. */
  run(player) {
    this.#settle();
    this.running = player;
    this.#since = this.#now();
  }

  /** Stop the clock, keeping everyone's remaining time (game paused or over). */
  stop() {
    this.run(null);
  }

  snapshot() {
    return { limitMs: this.limitMs, remaining: [this.left(0), this.left(1)], running: this.running };
  }

  /**
   * @param {{limitMs:number, remaining:[number,number], running:0|1|null}} snap
   * @param {{paused?:boolean, now?:() => number}} [options] paused: rebuild it stopped
   */
  static fromSnapshot(snap, { paused = false, now } = {}) {
    if (!snap || !Number.isFinite(snap.limitMs) || !Array.isArray(snap.remaining)) return null;
    const clock = new ClockModel({ limitMs: snap.limitMs, remaining: snap.remaining.map((ms) => Math.max(0, Number(ms) || 0)), now });
    if (!paused && (snap.running === 0 || snap.running === 1)) clock.run(snap.running);
    return clock;
  }

  #settle() {
    if (this.running === null) return;
    this.remaining[this.running] = this.left(this.running);
  }
}

/** 2:41, 0:09 – for the player chips. */
export function formatClock(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
