import { GameModel } from '../models/GameModel.js';
import { TUTORIAL_SIZE, TUTORIAL_STEPS } from '../tutorial/tutorialSteps.js';

const FRAME_MS = 850;        // default time per demo frame
const LOOP_PAUSE_MS = 1200;  // pause before a step's demo starts again
const WALLS_PER_PLAYER = 10;

/**
 * "How to play": a few steps, each with a looping demo on a mini board.
 * Shown once right after a new player creates their profile, and any time
 * from the "How to play" card on the home screen.
 */
export class TutorialController {
  #index = 0;
  #frame = 0;
  #timer = null;

  /**
   * @param {{
   *   view: import('../views/TutorialView.js').TutorialView,
   *   homeButton: HTMLElement,
   * }} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  init() {
    this.homeButton.addEventListener('click', () => this.open());
    this.view.on('next', () => {
      if (this.#index >= TUTORIAL_STEPS.length - 1) this.close();
      else this.#go(this.#index + 1);
    });
    this.view.on('back', () => {
      if (this.#index === 0) this.close(); // "Skip" on the first step
      else this.#go(this.#index - 1);
    });
    this.view.on('close', () => this.close());
  }

  open() {
    this.view.open();
    this.#go(0);
  }

  close() {
    clearTimeout(this.#timer);
    this.view.close();
  }

  #go(index) {
    this.#index = index;
    this.#frame = 0;
    this.view.renderStep(TUTORIAL_STEPS[index], index, TUTORIAL_STEPS.length);
    this.#play();
  }

  /** Show the current frame, then schedule the next one (looping). */
  #play() {
    clearTimeout(this.#timer);
    const frames = TUTORIAL_STEPS[this.#index].frames;
    const frame = frames[this.#frame];
    this.view.renderFrame(toGame(frame, frames[this.#frame - 1]), frame);

    const last = this.#frame === frames.length - 1;
    const wait = (frame.hold ?? FRAME_MS) + (last ? LOOP_PAUSE_MS : 0);
    this.#timer = setTimeout(() => {
      this.#frame = last ? 0 : this.#frame + 1;
      this.#play();
    }, wait);
  }
}

/** A frame as a real GameModel, so the board draws it exactly like a game. */
function toGame(frame, previous) {
  const walls = frame.walls ?? [];
  const added = previous && walls.length > (previous.walls?.length ?? 0) ? walls[walls.length - 1] : null;
  return GameModel.fromJSON({
    size: TUTORIAL_SIZE,
    wallLimit: WALLS_PER_PLAYER,
    pawns: [frame.p1, frame.p2],
    wallsLeft: [0, 1].map((p) => WALLS_PER_PLAYER - walls.filter((w) => w.by === p).length),
    walls,
    turn: frame.turn ?? 0,
    startingPlayer: 0,
    status: 'playing',
    winner: null,
    moveCount: 0,
    // Highlights a wall that was just placed, like in a real game.
    lastAction: added ? { by: added.by, kind: 'wall', o: added.o, r: added.r, c: added.c } : null,
    history: [],
  });
}
