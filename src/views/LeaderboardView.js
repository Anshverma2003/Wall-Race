import { EventEmitter } from '../core/EventEmitter.js';

const $ = (id) => document.getElementById(id);

const COLUMNS = {
  online: [
    { key: 'rank', label: '#', cls: 'col-rank' },
    { key: 'player', label: 'Player', cls: 'col-player' },
    { key: 'rating', label: 'Rating', cls: 'col-num' },
    { key: 'record', label: 'W–L', cls: 'col-num col-opt' },
    { key: 'winrate', label: 'Win %', cls: 'col-num' },
    { key: 'streak', label: 'Best streak', cls: 'col-num col-opt' },
  ],
  ai: [
    { key: 'rank', label: '#', cls: 'col-rank' },
    { key: 'player', label: 'Player', cls: 'col-player' },
    { key: 'wins', label: 'Hard wins', cls: 'col-num' },
    { key: 'fastest', label: 'Fastest win', cls: 'col-num' },
    { key: 'last', label: 'Last win', cls: 'col-num col-opt' },
  ],
};

const CAPTIONS = {
  online: 'Ranked by Elo rating. Everyone starts at 1200 — beating stronger players moves you up faster.',
  ai: 'Wins against the Hard AI. Ties go to the fastest win (fewest of your own moves).',
};

/**
 * Leaderboard screen: Online (Elo) and vs Hard AI tabs, period filter for
 * the AI board, top players plus the viewer's own row.
 *
 * Events: 'back', 'refresh', 'board' ('online'|'ai'), 'period' ('week'|'month'|'all')
 */
export class LeaderboardView extends EventEmitter {
  constructor() {
    super();
    this.boardTabs = $('leaderboard-board');
    this.periods = $('leaderboard-periods');
    this.caption = $('leaderboard-caption');
    this.thead = $('leaderboard-thead');
    this.tbody = $('leaderboard-tbody');
    this.state = $('leaderboard-state');

    $('btn-leaderboard-back').addEventListener('click', () => this.emit('back'));
    $('btn-leaderboard-refresh').addEventListener('click', () => this.emit('refresh'));
    this.boardTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (btn) this.emit('board', btn.dataset.value);
    });
    this.periods.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (btn) this.emit('period', btn.dataset.value);
    });
  }

  /**
   * @param {{
   *   board: 'online'|'ai', period: 'week'|'month'|'all',
   *   status: 'loading'|'ready'|'error',
   *   rows?: object[], meId?: string|null, limit: number, message?: string
   * }} s
   */
  render(s) {
    for (const btn of this.boardTabs.querySelectorAll('[data-value]')) {
      const on = btn.dataset.value === s.board;
      btn.setAttribute('aria-selected', String(on));
      btn.setAttribute('aria-checked', String(on));
    }
    this.periods.hidden = s.board !== 'ai';
    for (const btn of this.periods.querySelectorAll('[data-value]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.value === s.period));
    }
    this.caption.textContent = CAPTIONS[s.board];

    const cols = COLUMNS[s.board];
    const head = document.createElement('tr');
    for (const col of cols) head.appendChild(cell('th', col.label, col.cls));
    this.thead.replaceChildren(head);

    const rows = s.status === 'ready' ? s.rows ?? [] : [];
    const frag = document.createDocumentFragment();
    let lastRank = 0;
    for (const row of rows) {
      // Gap between the top list and the viewer's own row further down.
      if (Number(row.rank) > lastRank + 1 && lastRank >= s.limit) {
        const gap = document.createElement('tr');
        gap.className = 'leaderboard__gap';
        gap.appendChild(cell('td', '⋯', '')).colSpan = cols.length;
        frag.appendChild(gap);
      }
      lastRank = Number(row.rank);
      frag.appendChild(this.#row(s.board, cols, row, row.player_id === s.meId));
    }
    this.tbody.replaceChildren(frag);

    let message = '';
    if (s.status === 'loading') message = 'Loading…';
    else if (s.status === 'error') message = s.message ?? "Couldn't load the leaderboard.";
    else if (!rows.length) {
      message = s.board === 'online'
        ? 'No ranked online games yet. Play someone to claim the top spot!'
        : 'No wins against the Hard AI in this period yet. Be the first!';
    }
    this.state.textContent = message;
    this.state.hidden = !message;
    this.state.dataset.tone = s.status === 'error' ? 'error' : '';
  }

  #row(board, cols, r, isMe) {
    const tr = document.createElement('tr');
    if (isMe) tr.dataset.me = 'true';
    const values = board === 'online'
      ? {
          rank: r.rank,
          rating: r.rating,
          record: `${r.wins}–${r.losses}`,
          winrate: r.games ? `${Math.round((100 * r.wins) / r.games)}%` : '–',
          streak: r.best_streak,
        }
      : {
          rank: r.rank,
          wins: r.hard_wins,
          fastest: r.fastest ? `${r.fastest} moves · ${r.fastest_grid}×${r.fastest_grid}` : '–',
          last: r.last_win ? new Date(r.last_win).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '–',
        };

    for (const col of cols) {
      if (col.key !== 'player') {
        tr.appendChild(cell('td', String(values[col.key] ?? '–'), col.cls));
        continue;
      }
      const td = cell('td', '', col.cls);
      const name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = r.name;
      const tag = document.createElement('span');
      tag.className = 'lb-tag';
      tag.textContent = `#${r.tag}`;
      td.append(name, tag);
      if (isMe) {
        const you = document.createElement('span');
        you.className = 'lb-you';
        you.textContent = 'You';
        td.appendChild(you);
      }
      tr.appendChild(td);
    }
    return tr;
  }
}

function cell(tag, text, cls) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
