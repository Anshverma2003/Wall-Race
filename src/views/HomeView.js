import { EventEmitter } from '../core/EventEmitter.js';
import { ROOM } from '../config.js';

/**
 * Home screen: create a room, join with a code, rejoin a stored session or play vs AI.
 *
 * Events: 'create', 'join' (code), 'rejoin', 'forget-session', 'play-ai', 'ai-difficulty' (level)
 */
export class HomeView extends EventEmitter {
  constructor() {
    super();
    this.createBtn = document.getElementById('btn-create-room');
    this.joinForm = document.getElementById('form-join');
    this.joinBtn = document.getElementById('btn-join-room');
    this.codeInput = document.getElementById('input-room-code');
    this.message = document.getElementById('home-message');
    this.rejoinBanner = document.getElementById('home-rejoin');
    this.rejoinCode = document.getElementById('home-rejoin-code');
    this.rejoinBtn = document.getElementById('btn-rejoin');
    this.forgetBtn = document.getElementById('btn-forget-session');
    this.aiDifficulty = document.getElementById('ai-difficulty');
    this.aiMeta = document.getElementById('ai-meta');
    this.playAiBtn = document.getElementById('btn-play-ai');

    this.#bind();
  }

  /** @param {{difficulty:string, gridSize:number, wallLimit:number|null}} state */
  renderAi({ difficulty, gridSize, wallLimit }) {
    for (const btn of this.aiDifficulty.querySelectorAll('button[data-value]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.value === difficulty));
    }
    const walls = wallLimit === null ? 'unlimited walls' : `${wallLimit} wall${wallLimit === 1 ? '' : 's'} each`;
    this.aiMeta.textContent = `${gridSize} × ${gridSize} board · ${walls} · change these in ⚙ Settings`;
  }

  #bind() {
    this.createBtn.addEventListener('click', () => this.emit('create'));

    this.codeInput.addEventListener('input', () => {
      const digits = this.codeInput.value.replace(/\D/g, '').slice(0, ROOM.CODE_LENGTH);
      if (digits !== this.codeInput.value) this.codeInput.value = digits;
      if (this.message.dataset.tone === 'error') this.setMessage('');
    });

    this.joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.emit('join', this.codeInput.value.trim());
    });

    this.playAiBtn.addEventListener('click', () => this.emit('play-ai'));
    this.aiDifficulty.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn) this.emit('ai-difficulty', btn.dataset.value);
    });

    this.rejoinBtn.addEventListener('click', () => this.emit('rejoin'));
    this.forgetBtn.addEventListener('click', () => this.emit('forget-session'));
  }

  /** @param {false | 'create' | 'join' | 'rejoin'} busy */
  setBusy(busy) {
    const disabled = !!busy;
    this.createBtn.disabled = disabled;
    this.joinBtn.disabled = disabled;
    this.codeInput.disabled = disabled;
    this.rejoinBtn.disabled = disabled;
    this.playAiBtn.disabled = disabled;
    this.createBtn.textContent = busy === 'create' ? 'Creating room…' : 'Create room';
    this.joinBtn.textContent = busy === 'join' ? 'Joining…' : 'Join';
    this.rejoinBtn.textContent = busy === 'rejoin' ? 'Rejoining…' : 'Rejoin';
  }

  setMessage(text, tone = 'info') {
    this.message.textContent = text;
    this.message.dataset.tone = tone;
  }

  setCode(code) {
    this.codeInput.value = code;
  }

  focusCode() {
    this.codeInput.focus();
  }

  /** @param {string|null} code */
  showRejoin(code) {
    this.rejoinBanner.hidden = !code;
    this.rejoinCode.textContent = code ?? '';
  }
}
