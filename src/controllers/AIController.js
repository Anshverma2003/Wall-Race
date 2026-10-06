import { EventEmitter } from '../core/EventEmitter.js';
import { AI_LEVELS, AI_MIN_THINK_MS, ROOM, STORAGE_KEYS } from '../config.js';
import { GameModel } from '../models/GameModel.js';
import { RoomStatus } from '../models/RoomModel.js';
import { randomInt } from '../utils/random.js';

const HUMAN = 0; // P1 (red) – same seat as a host, so "flip board" behaves the same
const AI = 1;    // P2 (blue)

/**
 * Local game against the built-in AI. No network involved: the human's
 * actions and the AI's replies are applied straight to a local GameModel.
 * Implements the GameSession interface consumed by GameController.
 *
 * Emits 'change' whenever the session starts, ends or advances.
 */
export class AIController extends EventEmitter {
  /** @type {GameModel|null} */
  game = null;
  status = RoomStatus.LOBBY;
  difficulty = 'medium';

  #active = false;
  #thinking = false;
  /** Incremented to invalidate an in-flight AI search (leave / restart). */
  #token = 0;
  #gameController = null;

  /**
   * @param {{
   *   app: import('./AppController.js').AppController,
   *   settings: import('../models/SettingsModel.js').SettingsModel,
   *   storage: import('../services/StorageService.js').StorageService,
   *   aiService: import('../services/AIService.js').AIService,
   *   homeView: import('../views/HomeView.js').HomeView,
   * }} deps
   */
  constructor(deps) {
    super();
    Object.assign(this, deps);
  }

  setGameController(gameController) {
    this.#gameController = gameController;
  }

  /** @param {{canResume:boolean}} options resume a stored game unless an online session takes priority */
  init({ canResume }) {
    this.homeView.on('play-ai', () => this.start());
    this.homeView.on('ai-difficulty', (difficulty) => this.settings.update({ aiDifficulty: difficulty }));
    this.settings.on('change', () => this.#renderHome());
    this.#renderHome();

    if (canResume) this.#resume();
  }

  // ------------------------------------------------ GameSession interface

  get kind() { return 'ai'; }
  get isActive() { return this.#active; }
  get localIndex() { return HUMAN; }
  get opponentName() { return 'AI'; }
  get opponentOnline() { return true; }
  get opponentThinking() { return this.#thinking; }
  get banner() { return null; }
  get footer() { return { label: 'vs AI', value: AI_LEVELS[this.difficulty].label }; }
  get rematchVotes() { return [false, false]; }
  get rematchNeedsBoth() { return false; }
  get leaveWarning() { return 'Your game against the AI will end.'; }
  get canEditMatch() { return this.status !== RoomStatus.PLAYING; }
  get matchSettings() { return this.settings.matchSettings; }

  // --------------------------------------------------------------- actions

  start() {
    this.#cancelThinking();
    const { gridSize, wallLimit } = this.settings.matchSettings;
    const first = randomInt(2);
    this.difficulty = this.settings.aiDifficulty;
    this.game = new GameModel({ size: gridSize, wallLimit, startingPlayer: first });
    this.status = RoomStatus.PLAYING;
    this.#active = true;

    this.#gameController?.closeModals();
    this.app.showScreen('game');
    this.#afterAction({ kind: 'start', first });
  }

  submitAction(action) {
    if (!this.#active || this.#thinking || this.game.turn !== HUMAN) return false;
    const result = this.game.applyAction(HUMAN, action);
    if (!result.ok) {
      this.#gameController?.update({ kind: 'rejected', by: HUMAN, reason: result.reason });
      return true;
    }
    this.#afterAction({ kind: 'action', by: HUMAN, action: this.game.lastAction });
    return true;
  }

  requestRematch() {
    this.start();
  }

  leave() {
    this.#cancelThinking();
    this.#active = false;
    this.game = null;
    this.status = RoomStatus.LOBBY;
    this.storage.remove(STORAGE_KEYS.AI_SESSION);
    this.#gameController?.closeModals();
    this.app.showScreen('home');
    this.emit('change');
  }

  // -------------------------------------------------------------- internals

  #afterAction(event) {
    if (this.game.isOver) this.status = RoomStatus.FINISHED;
    this.#save();
    this.emit('change');
    this.#gameController?.update(event);
    if (!this.game.isOver && this.game.turn === AI) this.#think();
  }

  async #think() {
    const token = ++this.#token;
    this.#thinking = true;
    this.#gameController?.refresh();

    const started = performance.now();
    let action = null;
    try {
      ({ action } = await this.#requestMove());
    } catch (err) {
      if (token !== this.#token) return; // cancelled
      console.warn('[AIController] AI search failed, using fallback move', err);
    }

    const remaining = AI_MIN_THINK_MS - (performance.now() - started);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    if (token !== this.#token || !this.#active) return;

    this.#thinking = false;
    let result = action ? this.game.applyAction(AI, action) : { ok: false };
    if (!result.ok) {
      // Safety net – the engine only proposes legal actions, but never get stuck.
      const [move] = this.game.getLegalMoves(AI);
      result = this.game.applyAction(AI, { kind: 'move', r: move.r, c: move.c });
    }
    this.#afterAction({ kind: 'action', by: AI, action: this.game.lastAction });
  }

  async #requestMove() {
    const json = this.game.toJSON();
    try {
      return await this.aiService.chooseAction(json, AI, this.difficulty);
    } catch (err) {
      // Worker could not start (old browser / blocked) → service now runs inline.
      if (err?.message === 'worker-failed') return this.aiService.chooseAction(json, AI, this.difficulty);
      throw err;
    }
  }

  #cancelThinking() {
    this.#token++;
    if (this.#thinking) this.aiService.cancelAll();
    this.#thinking = false;
  }

  #renderHome() {
    const { gridSize, wallLimit } = this.settings.matchSettings;
    this.homeView.renderAi({ difficulty: this.settings.aiDifficulty, gridSize, wallLimit });
  }

  // -------------------------------------------------------- persistence

  #save() {
    if (!this.#active) return;
    this.storage.set(STORAGE_KEYS.AI_SESSION, {
      difficulty: this.difficulty,
      status: this.status,
      game: this.game.toJSON(),
      savedAt: Date.now(),
    });
  }

  /** Continue a vs-AI game after a page refresh. */
  #resume() {
    const data = this.storage.get(STORAGE_KEYS.AI_SESSION);
    if (!data?.game || !AI_LEVELS[data.difficulty] || Date.now() - data.savedAt > ROOM.SESSION_TTL_MS) {
      this.storage.remove(STORAGE_KEYS.AI_SESSION);
      return;
    }
    try {
      this.game = GameModel.fromJSON(data.game);
    } catch {
      this.storage.remove(STORAGE_KEYS.AI_SESSION);
      return;
    }
    this.difficulty = data.difficulty;
    this.status = this.game.isOver ? RoomStatus.FINISHED : RoomStatus.PLAYING;
    this.#active = true;
    this.app.showScreen('game');
    this.emit('change');
    this.#gameController?.update(null);
    if (!this.game.isOver && this.game.turn === AI) this.#think();
  }
}
