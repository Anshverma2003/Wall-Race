import { EventEmitter } from '../core/EventEmitter.js';

const $ = (id) => document.getElementById(id);
const MASKED_CODE = '••••-••••-••••-••••';

/**
 * Player identity UI:
 *  - the first-open dialog (create profile / restore with a recovery code / save the code),
 *  - the Profile section of the settings dialog,
 *  - the name#tag badge in the top bar.
 *
 * Events: 'create' ({name, tag}), 'tag-input' (tag), 'recover' (code), 'done',
 *         'save-name' (name), 'save-tag' (tag), 'copy-code', 'switch', 'badge', 'recover-back'
 */
export class ProfileView extends EventEmitter {
  #codeVisible = false;
  #code = '';

  constructor() {
    super();
    this.overlay = $('player-overlay');
    this.panels = [...this.overlay.querySelectorAll('[data-panel]')];
    this.nameInput = $('player-name');
    this.tagInput = $('player-tag');
    this.createMsg = $('player-create-message');
    this.recoverInput = $('player-recovery');
    this.recoverMsg = $('player-recover-message');

    this.badge = $('btn-player-badge');
    this.settingsName = $('profile-name');
    this.settingsTag = $('profile-tag');
    this.settingsNote = $('profile-note');
    this.settingsCode = $('profile-code');
    this.codeToggle = $('btn-profile-code-toggle');

    for (const input of [this.tagInput, this.settingsTag]) {
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 4);
      });
    }
    this.tagInput.addEventListener('input', () => this.emit('tag-input', this.tagInput.value));

    $('form-player-create').addEventListener('submit', (e) => {
      e.preventDefault();
      this.emit('create', { name: this.nameInput.value, tag: this.tagInput.value });
    });
    $('form-player-recover').addEventListener('submit', (e) => {
      e.preventDefault();
      this.emit('recover', this.recoverInput.value);
    });
    this.overlay.querySelector('[data-goto="recover"]').addEventListener('click', () => this.showPanel('recover'));
    this.overlay.querySelector('[data-goto="back"]').addEventListener('click', () => this.emit('recover-back'));
    $('btn-player-done').addEventListener('click', () => this.emit('done'));
    $('btn-player-copy-code').addEventListener('click', () => this.emit('copy-code'));

    $('form-profile-name').addEventListener('submit', (e) => {
      e.preventDefault();
      this.emit('save-name', this.settingsName.value);
    });
    $('form-profile-tag').addEventListener('submit', (e) => {
      e.preventDefault();
      this.emit('save-tag', this.settingsTag.value);
    });
    this.codeToggle.addEventListener('click', () => {
      this.#codeVisible = !this.#codeVisible;
      this.#renderCode();
    });
    $('btn-profile-code-copy').addEventListener('click', () => this.emit('copy-code'));
    $('btn-profile-switch').addEventListener('click', () => this.emit('switch'));
    this.badge.addEventListener('click', () => this.emit('badge'));
  }

  // ------------------------------------------------------- first-open dialog

  open(panel = 'create') {
    this.overlay.hidden = false;
    this.showPanel(panel);
  }

  close() {
    this.overlay.hidden = true;
    this.setMessage('create', '');
    this.setMessage('recover', '');
    this.recoverInput.value = '';
  }

  get isOpen() {
    return !this.overlay.hidden;
  }

  /** @param {'create'|'recover'|'saved'} name */
  showPanel(name) {
    for (const panel of this.panels) panel.hidden = panel.dataset.panel !== name;
    const focus = { create: this.nameInput, recover: this.recoverInput, saved: $('btn-player-done') }[name];
    requestAnimationFrame(() => focus?.focus());
  }

  showSaved(label, code) {
    $('player-welcome').textContent = label;
    $('player-new-code').textContent = code;
    this.showPanel('saved');
  }

  /** @param {'create'|'recover'} panel */
  setMessage(panel, text, tone = 'error') {
    const el = panel === 'create' ? this.createMsg : this.recoverMsg;
    el.textContent = text;
    el.dataset.tone = tone;
  }

  setBusy(panel, busy) {
    const btn = panel === 'create' ? $('btn-player-create') : $('btn-player-recover');
    btn.disabled = busy;
    btn.textContent = busy ? 'Please wait…' : panel === 'create' ? 'Continue' : 'Restore profile';
  }

  // ------------------------------------------------------------- top bar

  renderBadge(player) {
    this.badge.hidden = !player.exists;
    $('player-badge-name').textContent = player.name;
    $('player-badge-tag').textContent = player.exists ? `#${player.tag}` : '';
  }

  // ------------------------------------------------------ settings section

  /**
   * @param {import('../models/PlayerModel.js').PlayerModel} player
   * @param {{note?:string, tone?:string}} [status]
   */
  renderSettings(player, status = {}) {
    $('setting-profile-group').hidden = !player.exists;
    if (!player.exists) return;
    if (document.activeElement !== this.settingsName) this.settingsName.value = player.name;
    if (document.activeElement !== this.settingsTag) this.settingsTag.value = player.tag;

    const unlocks = player.tagUnlocksAt;
    this.settingsTag.disabled = !!unlocks;
    this.settingsTag.closest('form').querySelector('button').disabled = !!unlocks;

    let note = status.note;
    if (note === undefined) {
      note = unlocks
        ? `You can change your tag again on ${unlocks.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.`
        : 'Your name can change any time. Your tag can change once every 30 days.';
    }
    this.settingsNote.textContent = note;
    this.settingsNote.dataset.tone = status.tone ?? '';

    this.#code = player.code ?? '';
    this.#renderCode();
  }

  #renderCode() {
    this.settingsCode.textContent = this.#codeVisible ? this.#code : MASKED_CODE;
    this.codeToggle.textContent = this.#codeVisible ? 'Hide' : 'Show';
  }
}
