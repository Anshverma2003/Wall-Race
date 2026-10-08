import { EventEmitter } from '../core/EventEmitter.js';
import { PLAYER_LABELS } from '../config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Geometry in SVG user units.
const CELL = 100;
const PAD = 40;
const DOT_R = 8;
const PAWN_R = 33;
const MOVE_R = 18;
const WALL_W = 12;
const SLOT_THICKNESS = 34;
const SLOT_INSET = DOT_R + 2;

/** Premove highlight hue – amber contrasts with the black board, red P1 and blue P2. */
const PREMOVE_HUE = 38;

/**
 * Colour of the i-th of n premoves: one hue, from dark (first) to light (last),
 * so the order in which they will be played is visible.
 */
export function premoveShade(i, n) {
  const t = n <= 1 ? 0 : i / (n - 1);
  const lightness = 38 + t * 30; // 38% → 68%
  return `hsl(${PREMOVE_HUE} 95% ${lightness}%)`;
}

/**
 * Renders the board as SVG and turns pointer input into intents.
 *
 * Modes:
 *  'play'    – your turn: legal squares are highlighted, walls can be placed
 *  'premove' – opponent's turn: any square or wall gap can be queued as a premove
 *  'view'    – read-only (history browsing, game over, waiting)
 *
 * Events:
 *  'move'    ({r, c})          – play mode: player clicked a highlighted square
 *  'cell'    ({r, c})          – premove mode: player clicked any square
 *  'wall'    ({o, r, c})       – player confirmed a wall placement (play or premove)
 *  'invalid' (reason: string)  – player tried an illegal wall
 *
 * Mouse: hover a gap between two dots to preview a wall, click to place it.
 * Touch: first tap previews, second tap on the same gap confirms.
 */
export class BoardView extends EventEmitter {
  #svg;
  #layers = {};
  #pawns = [];
  #layoutKey = '';
  #size = 0;
  #flip = false;
  /** @type {'play'|'premove'|'view'} */
  #mode = 'view';
  #validateWall = () => ({ ok: false });
  #lastPointerType = 'mouse';
  #pendingSlot = null;

  /** @param {SVGSVGElement} svg */
  constructor(svg) {
    super();
    this.#svg = svg;
    this.#bindEvents();
  }

  /**
   * @param {{
   *   game: import('../models/GameModel.js').GameModel,
   *   localIndex: 0|1,
   *   flip: boolean,
   *   mode: 'play'|'premove'|'view',
   *   validateWall: (wall:{o:string,r:number,c:number}) => {ok:boolean, reason?:string},
   *   premoves?: object[],                       queued premoves to highlight
   *   pawnOverride?: {player:0|1, r:number, c:number} | null   draw this pawn here instead
   * }} params
   */
  render({ game, localIndex, flip, mode, validateWall, premoves = [], pawnOverride = null }) {
    const shouldFlip = flip && localIndex === 0; // P1 starts at the top; flip so they see themselves at the bottom
    const key = `${game.size}:${shouldFlip}`;
    if (key !== this.#layoutKey) {
      this.#size = game.size;
      this.#flip = shouldFlip;
      this.#layoutKey = key;
      this.#build();
    }

    this.#mode = mode;
    this.#validateWall = validateWall;
    this.#svg.dataset.interactive = String(mode !== 'view');
    this.#svg.dataset.mode = mode;
    this.#clearPreview();

    this.#renderWalls(game);
    this.#renderPremoves(premoves);
    this.#renderMoves(game, localIndex, mode === 'play');
    this.#renderSlots(game, localIndex, mode);
    this.#renderPawns(game, pawnOverride);
  }

  /** True when the last pointer interaction was a touch (used for hints). */
  get isTouch() {
    return this.#lastPointerType === 'touch';
  }

  // ------------------------------------------------------------- geometry

  #x(gx) {
    return PAD + (this.#flip ? this.#size - gx : gx) * CELL;
  }

  #y(gy) {
    return PAD + (this.#flip ? this.#size - gy : gy) * CELL;
  }

  #cellCenter(r, c) {
    return { x: this.#x(c + 0.5), y: this.#y(r + 0.5) };
  }

  /** End points of a wall segment in SVG units. */
  #wallLine({ o, r, c }) {
    return o === 'h'
      ? { x1: this.#x(c), y1: this.#y(r), x2: this.#x(c + 1), y2: this.#y(r) }
      : { x1: this.#x(c), y1: this.#y(r), x2: this.#x(c), y2: this.#y(r + 1) };
  }

  /** Same segment, shortened so it sits between the two dots. */
  #wallLineInset(wall, inset) {
    const l = this.#wallLine(wall);
    const dx = Math.sign(l.x2 - l.x1) * inset;
    const dy = Math.sign(l.y2 - l.y1) * inset;
    return { x1: l.x1 + dx, y1: l.y1 + dy, x2: l.x2 - dx, y2: l.y2 - dy };
  }

  // ---------------------------------------------------------------- build

  #build() {
    const n = this.#size;
    const total = PAD * 2 + n * CELL;
    const svg = this.#svg;
    svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
    svg.replaceChildren();

    const layer = (name) => {
      const g = el('g', { class: `layer-${name}` });
      svg.appendChild(g);
      this.#layers[name] = g;
      return g;
    };

    // Goal rows: tinted with the colour of the player who must reach them.
    const goals = layer('goals');
    for (const [player, row] of [[0, n - 1], [1, 0]]) {
      const top = Math.min(this.#y(row), this.#y(row + 1));
      goals.appendChild(el('rect', { class: 'goal-row', 'data-player': player, x: PAD, y: top, width: n * CELL, height: CELL }));
    }

    layer('premove-cells');

    const dots = layer('dots');
    for (let gy = 0; gy <= n; gy++) {
      for (let gx = 0; gx <= n; gx++) {
        dots.appendChild(el('circle', { class: 'dot', cx: this.#x(gx), cy: this.#y(gy), r: DOT_R }));
      }
    }

    layer('walls');
    layer('premove-walls');
    layer('moves');

    // Whole-square hit areas, only clickable in premove mode (any square is accepted).
    const cells = layer('cells');
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const { x, y } = this.#cellCenter(r, c);
        cells.appendChild(el('rect', {
          class: 'cell-hit', 'data-cell': '', 'data-r': r, 'data-c': c,
          x: x - CELL / 2, y: y - CELL / 2, width: CELL, height: CELL,
        }));
      }
    }

    const slots = layer('slots');
    for (let r = 1; r < n; r++) {
      for (let c = 0; c < n; c++) slots.appendChild(this.#slotRect({ o: 'h', r, c }));
    }
    for (let r = 0; r < n; r++) {
      for (let c = 1; c < n; c++) slots.appendChild(this.#slotRect({ o: 'v', r, c }));
    }

    layer('preview');

    const pawns = layer('pawns');
    this.#pawns = [0, 1].map((p) => {
      const g = el('g', { class: 'pawn', 'data-player': p });
      g.append(
        el('circle', { class: 'pawn__ring', r: PAWN_R, cx: 0, cy: 0 }),
        el('circle', { class: 'pawn__body', r: PAWN_R, cx: 0, cy: 0 }),
        el('text', { class: 'pawn__label', x: 0, y: 1 }, PLAYER_LABELS[p]),
      );
      g.style.transition = 'none'; // no slide-in on first paint
      pawns.appendChild(g);
      return g;
    });
  }

  #slotRect(wall) {
    const l = this.#wallLineInset(wall, SLOT_INSET);
    const horizontal = wall.o === 'h';
    const x = Math.min(l.x1, l.x2) - (horizontal ? 0 : SLOT_THICKNESS / 2);
    const y = Math.min(l.y1, l.y2) - (horizontal ? SLOT_THICKNESS / 2 : 0);
    const len = CELL - SLOT_INSET * 2;
    return el('rect', {
      class: 'slot',
      'data-o': wall.o,
      'data-r': wall.r,
      'data-c': wall.c,
      x,
      y,
      width: horizontal ? len : SLOT_THICKNESS,
      height: horizontal ? SLOT_THICKNESS : len,
      rx: 6,
    });
  }

  // --------------------------------------------------------------- render

  #renderWalls(game) {
    const last = game.lastAction?.kind === 'wall' ? game.lastAction : null;
    const frag = document.createDocumentFragment();
    for (const wall of game.walls) {
      const l = this.#wallLineInset(wall, 3);
      const isLatest = last && last.o === wall.o && last.r === wall.r && last.c === wall.c;
      frag.appendChild(el('line', {
        class: `wall${isLatest ? ' wall--latest' : ''}`,
        'data-player': wall.by,
        ...l,
        'stroke-width': WALL_W,
      }));
    }
    this.#layers.walls.replaceChildren(frag);
  }

  #renderMoves(game, localIndex, interactive) {
    const frag = document.createDocumentFragment();
    if (interactive) {
      for (const move of game.getLegalMoves(localIndex)) {
        const { x, y } = this.#cellCenter(move.r, move.c);
        // Large transparent hit circle + visible marker.
        const g = el('g', { 'data-move': '', 'data-r': move.r, 'data-c': move.c, class: 'move' });
        g.append(
          el('circle', { cx: x, cy: y, r: CELL * 0.32, fill: 'transparent', style: 'cursor:pointer' }),
          el('circle', { class: 'move-target', 'data-player': localIndex, cx: x, cy: y, r: MOVE_R }),
        );
        frag.appendChild(g);
      }
    }
    this.#layers.moves.replaceChildren(frag);
  }

  #renderSlots(game, localIndex, mode) {
    const canWall = mode === 'play' && game.hasWallsLeft(localIndex);
    for (const slot of this.#layers.slots.children) {
      const { o, r, c } = slotData(slot);
      // Premove mode accepts any gap; legality is checked when the premove is played.
      const enabled = mode === 'premove' || (canWall && !game.hasWall(o, r, c));
      slot.dataset.disabled = String(!enabled);
    }
  }

  /** Premoves: highlighted squares and walls in shades of one colour, dark (first) → light (last). */
  #renderPremoves(premoves) {
    const cells = document.createDocumentFragment();
    const walls = document.createDocumentFragment();
    const inset = 6;
    premoves.forEach((p, i) => {
      const color = premoveShade(i, premoves.length);
      if (p.kind === 'move') {
        const { x, y } = this.#cellCenter(p.r, p.c);
        cells.appendChild(el('rect', {
          class: 'premove-cell',
          x: x - CELL / 2 + inset, y: y - CELL / 2 + inset,
          width: CELL - inset * 2, height: CELL - inset * 2, rx: 10,
          fill: color,
        }));
      } else {
        walls.appendChild(el('line', {
          class: 'premove-wall',
          ...this.#wallLineInset(p, 3),
          stroke: color,
          'stroke-width': WALL_W,
        }));
      }
    });
    this.#layers['premove-cells'].replaceChildren(cells);
    this.#layers['premove-walls'].replaceChildren(walls);
  }

  #renderPawns(game, pawnOverride) {
    game.pawns.forEach((actual, p) => {
      const g = this.#pawns[p];
      const pos = pawnOverride && pawnOverride.player === p ? pawnOverride : actual;
      const { x, y } = this.#cellCenter(pos.r, pos.c);
      g.style.transform = `translate(${x}px, ${y}px)`;
      g.dataset.active = String(!game.isOver && game.turn === p);
      if (g.style.transition === 'none') {
        // Re-enable the slide animation after the first paint.
        requestAnimationFrame(() => requestAnimationFrame(() => { g.style.transition = ''; }));
      }
    });
  }

  // ---------------------------------------------------------------- input

  #bindEvents() {
    const svg = this.#svg;

    svg.addEventListener('pointerdown', (e) => {
      this.#lastPointerType = e.pointerType || 'mouse';
    });

    svg.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch' || this.#pendingSlot) return;
      const slot = e.target.closest('.slot');
      if (slot && this.#isSlotUsable(slot)) this.#showPreview(slotData(slot), false);
    });

    svg.addEventListener('pointerout', (e) => {
      if (e.pointerType === 'touch' || this.#pendingSlot) return;
      if (e.target.closest('.slot')) this.#clearPreview();
    });

    svg.addEventListener('click', (e) => {
      if (this.#mode === 'view') return;

      const move = e.target.closest('[data-move]');
      if (move && this.#mode === 'play') {
        this.#clearPreview();
        this.emit('move', { r: Number(move.dataset.r), c: Number(move.dataset.c) });
        return;
      }

      const slot = e.target.closest('.slot');
      if (!slot || !this.#isSlotUsable(slot)) {
        this.#clearPreview();
        const cell = e.target.closest('[data-cell]');
        if (cell && this.#mode === 'premove') {
          this.emit('cell', { r: Number(cell.dataset.r), c: Number(cell.dataset.c) });
        }
        return;
      }

      const wall = slotData(slot);
      const check = this.#validateWall(wall);
      if (!check.ok) {
        this.#clearPreview();
        this.emit('invalid', check.reason);
        return;
      }

      const needsConfirm = this.#lastPointerType === 'touch';
      if (needsConfirm && !sameWall(this.#pendingSlot, wall)) {
        this.#showPreview(wall, true);
        return;
      }

      this.#clearPreview();
      this.emit('wall', wall);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.#clearPreview();
    });
  }

  #isSlotUsable(slot) {
    return this.#mode !== 'view' && slot.dataset.disabled !== 'true';
  }

  #showPreview(wall, pending) {
    const check = this.#validateWall(wall);
    const l = this.#wallLineInset(wall, 3);
    const line = el('line', {
      class: `wall-preview${this.#mode === 'premove' ? ' wall-preview--premove' : ''}`,
      'data-valid': String(check.ok),
      'data-pending': String(pending),
      ...l,
      'stroke-width': WALL_W,
    });
    if (!check.ok) line.appendChild(el('title', {}, check.reason));
    this.#layers.preview.replaceChildren(line);
    this.#pendingSlot = pending ? wall : null;
    this.emit('preview', pending ? wall : null);
  }

  #clearPreview() {
    this.#layers.preview?.replaceChildren();
    if (this.#pendingSlot) {
      this.#pendingSlot = null;
      this.emit('preview', null);
    }
  }
}

// ----------------------------------------------------------------- helpers

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

function slotData(slot) {
  return { o: slot.dataset.o, r: Number(slot.dataset.r), c: Number(slot.dataset.c) };
}

function sameWall(a, b) {
  return !!a && !!b && a.o === b.o && a.r === b.r && a.c === b.c;
}
