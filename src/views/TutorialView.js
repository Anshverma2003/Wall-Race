import { EventEmitter } from '../core/EventEmitter.js';
import { BoardView } from './BoardView.js';

const $ = (id) => document.getElementById(id);

/**
 * The "How to play" dialog: a small animated board, a title and a short text
 * per step, plus Back / Next and progress dots.
 *
 * Events: 'next', 'back', 'close'
 */
export class TutorialView extends EventEmitter {
  constructor() {
    super();
    this.overlay = $('tutorial-overlay');
    this.board = new BoardView($('tutorial-board'));
    this.backBtn = $('btn-tutorial-back');
    this.nextBtn = $('btn-tutorial-next');
    this.dots = $('tutorial-dots');

    this.nextBtn.addEventListener('click', () => this.emit('next'));
    this.backBtn.addEventListener('click', () => this.emit('back'));
    $('btn-tutorial-close').addEventListener('click', () => this.emit('close'));
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.emit('close');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.emit('close');
    });
  }

  get isOpen() {
    return !this.overlay.hidden;
  }

  open() {
    this.overlay.hidden = false;
    requestAnimationFrame(() => this.nextBtn.focus());
  }

  close() {
    this.overlay.hidden = true;
  }

  /** @param {{title:string, text:string}} step */
  renderStep(step, index, count) {
    $('tutorial-count').textContent = `· ${index + 1} / ${count}`;
    $('tutorial-title').textContent = step.title;
    $('tutorial-text').textContent = step.text;
    this.backBtn.textContent = index === 0 ? 'Skip' : 'Back';
    this.nextBtn.textContent = index === count - 1 ? "Let's play!" : 'Next';
    this.dots.replaceChildren(
      ...Array.from({ length: count }, (_, i) => {
        const dot = document.createElement('span');
        dot.className = 'tutorial__dot';
        if (i === index) dot.dataset.active = 'true';
        return dot;
      }),
    );
  }

  /**
   * One frame of the demo animation.
   * @param {import('../models/GameModel.js').GameModel} game
   * @param {{showMoves?:boolean, ghost?:{wall:object, ok:boolean}|null}} frame
   */
  renderFrame(game, frame) {
    this.board.render({
      game,
      localIndex: 0,
      flip: true, // "you" (red) at the bottom, like in a real game
      mode: frame.showMoves ? 'play' : 'view',
      validateWall: () => ({ ok: false }),
    });
    if (frame.ghost) this.board.showGhostWall(frame.ghost.wall, frame.ghost.ok);
  }
}
