import { EventEmitter } from '../core/EventEmitter.js';
import { BoardView } from './BoardView.js';

const $ = (id) => document.getElementById(id);

const HOW = {
  goal: { won: 'reached the other side', lost: 'opponent reached the other side' },
  timeout: { won: 'opponent ran out of time', lost: 'ran out of time' },
  forfeit: { won: 'opponent left', lost: 'you left' },
};

const formatDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');

/**
 * "My games": the list of the player's recent online games and the replay
 * screen (read-only board + |< < > >| buttons).
 *
 * Events: 'back', 'refresh', 'open' (matchId), 'replay-back', 'replay-nav' ('first'|'prev'|'next'|'last')
 */
export class HistoryView extends EventEmitter {
  constructor() {
    super();
    this.list = $('history-list');
    this.state = $('history-state');
    this.board = new BoardView($('replay-board'));
    this.nav = Object.fromEntries([...$('replay-nav').querySelectorAll('[data-nav]')].map((b) => [b.dataset.nav, b]));
    this.players = [...document.querySelectorAll('.replay__player')];

    $('btn-history-back').addEventListener('click', () => this.emit('back'));
    $('btn-history-refresh').addEventListener('click', () => this.emit('refresh'));
    $('btn-replay-back').addEventListener('click', () => this.emit('replay-back'));
    $('replay-nav').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-nav]');
      if (btn && !btn.disabled) this.emit('replay-nav', btn.dataset.nav);
    });
    this.list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-match]');
      if (row && row.dataset.replay === 'true') this.emit('open', row.dataset.match);
    });
  }

  // ------------------------------------------------------------------ list

  /** @param {{status:'loading'|'ready'|'error', games?:object[], message?:string}} s */
  renderList(s) {
    const games = s.status === 'ready' ? s.games ?? [] : [];
    this.list.replaceChildren(...games.map((g) => this.#row(g)));

    let message = '';
    if (s.status === 'loading') message = 'Loading…';
    else if (s.status === 'error') message = s.message ?? "Couldn't load your games.";
    else if (!games.length) message = 'No online games yet. Create a room and challenge a friend!';
    this.state.textContent = message;
    this.state.hidden = !message;
    this.state.dataset.tone = s.status === 'error' ? 'error' : '';
  }

  #row(g) {
    const li = document.createElement('li');
    li.className = 'history__row';
    li.dataset.match = g.match_id;
    li.dataset.replay = String(!!g.can_replay);
    li.dataset.result = g.won ? 'won' : 'lost';
    if (g.can_replay) {
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.emit('open', g.match_id);
        }
      });
    }

    const badge = el('span', 'history__badge', g.won ? 'W' : 'L');
    const main = el('span', 'history__main');
    const who = el('span', 'history__who');
    who.append(el('span', 'lb-name', g.opponent_name), el('span', 'lb-tag', `#${g.opponent_tag}`));
    const how = HOW[g.end_reason] ?? HOW.goal;
    const detail = [
      g.won ? `Won – ${how.won}` : `Lost – ${how.lost}`,
      `${g.moves} moves`,
      `${g.grid_size}×${g.grid_size}`,
    ].join(' · ');
    main.append(who, el('span', 'history__detail', detail), el('span', 'history__date', formatDate(g.played_at)));

    const delta = g.rating_after - g.rating_before;
    const rating = el('span', 'history__rating');
    rating.append(el('b', '', String(g.rating_after)), el('span', `history__delta history__delta--${delta >= 0 ? 'up' : 'down'}`, signed(delta)));

    li.append(badge, main, rating);
    if (g.can_replay) {
      li.appendChild(el('span', 'history__chev', '›'));
      li.setAttribute('aria-label', `Replay game against ${g.opponent_name}`);
    } else {
      li.title = 'Replay not available: this game was played before moves were saved.';
    }
    return li;
  }

  // ---------------------------------------------------------------- replay

  /**
   * @param {{
   *   game: import('../models/GameModel.js').GameModel,   position to show
   *   info: object,          my_game() result
   *   ply: number, total: number, flip: boolean
   * }} s
   */
  renderReplay({ game, info, ply, total, flip }) {
    const me = info.my_index;
    const opp = info.players[1 - me];
    $('replay-title').textContent = `vs ${opp.name}#${opp.tag}`;

    const won = info.winner === me;
    const how = HOW[info.end_reason] ?? HOW.goal;
    const mine = info.players[me];
    const delta = mine.rating_after - mine.rating_before;
    $('replay-result').textContent = `${won ? 'You won' : 'You lost'} – ${won ? how.won : how.lost} · Rating ${mine.rating_after} (${signed(delta)}) · ${formatDate(info.played_at)}`;
    $('replay-result').dataset.result = won ? 'won' : 'lost';

    this.players.forEach((row, i) => {
      const p = info.players[i];
      row.querySelector('.replay__name').textContent = `${i === me ? 'You' : `${p.name}#${p.tag}`} · ${p.rating_before}`;
      const left = game.wallsLeft[i];
      row.querySelector('.replay__walls').textContent = `Walls: ${left === null ? '∞' : left}`;
      row.dataset.active = String(!game.isOver && game.turn === i && ply < total);
    });

    this.board.render({ game, localIndex: me, flip, mode: 'view', validateWall: () => ({ ok: false }) });

    this.nav.first.disabled = ply === 0;
    this.nav.prev.disabled = ply === 0;
    this.nav.next.disabled = ply >= total;
    this.nav.last.disabled = ply >= total;
    $('replay-counter').textContent = ply === 0 ? `Start · ${total} moves` : `Move ${ply} of ${total}`;
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
