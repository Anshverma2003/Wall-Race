import { PlayerModel } from '../models/PlayerModel.js';
import { copyText } from '../utils/clipboard.js';

const ERRORS = {
  INVALID_NAME: 'Name must be 3–16 characters: letters, numbers, spaces, _ or -.',
  INVALID_TAG: 'Tag must be exactly 4 digits.',
  TAG_LOCKED: 'You can only change your tag once every 30 days.',
  BAD_CODE: "That recovery code doesn't match any player.",
  RATE_LIMIT: 'Too many new profiles from this network. Please try again in an hour.',
  NETWORK: "Couldn't reach the server. Check your internet connection and try again.",
};

const describe = (err, tag) =>
  err?.code === 'TAG_TAKEN' ? `#${tag} is already taken. Please choose another tag.` : ERRORS[err?.code] ?? 'Something went wrong. Please try again.';

/** WR-XXXX-XXXX-XXXX-XXXX regardless of how it was typed. */
function formatCode(raw) {
  const chars = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^WR/, '');
  return chars.length === 16 ? `WR-${chars.match(/.{4}/g).join('-')}` : null;
}

/**
 * Player identity: requires a name#tag on first open, restores profiles from
 * a recovery code, and handles name / tag changes from Settings.
 */
export class ProfileController {
  #tagCheckTimer = null;
  #tagCheckSeq = 0;

  /**
   * @param {{
   *   player: PlayerModel,
   *   supabase: import('../services/SupabaseService.js').SupabaseService,
   *   view: import('../views/ProfileView.js').ProfileView,
   *   settingsCtrl: import('./SettingsController.js').SettingsController,
   *   toast: import('../views/ToastView.js').ToastView,
   * }} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  init() {
    const { view, player } = this;
    view.on('tag-input', (tag) => this.#checkTag(tag));
    view.on('create', (form) => this.#create(form));
    view.on('recover', (code) => this.#recover(code));
    view.on('recover-back', () => (player.exists ? view.close() : view.showPanel('create')));
    view.on('done', () => {
      view.close();
      this.toast.show(`Welcome, ${player.label}!`, 'success');
    });
    view.on('copy-code', () => this.#copyCode());
    view.on('save-name', (name) => this.#saveName(name));
    view.on('save-tag', (tag) => this.#saveTag(tag));
    view.on('switch', () => {
      this.settingsCtrl.close();
      view.open('recover');
    });
    view.on('badge', () => this.settingsCtrl.open());
    this.settingsCtrl.onOpen(() => view.renderSettings(player));

    player.on('change', () => this.#render());
    this.#render();

    if (player.exists) this.refresh();
    else view.open('create');
  }

  /** Pull the latest profile (rating, name changes from another device). */
  async refresh() {
    if (!this.player.exists) return;
    try {
      this.player.set(await this.supabase.getPlayer(this.player.code));
    } catch (err) {
      if (err.code === 'BAD_CODE') {
        this.player.clear();
        this.view.open('create');
        this.view.setMessage('create', 'Your saved profile no longer exists. Please create a new one.');
      }
      // Network problems: keep using the cached profile.
    }
  }

  #render() {
    this.view.renderBadge(this.player);
    this.view.renderSettings(this.player);
  }

  // --------------------------------------------------------------- create

  #checkTag(tag) {
    clearTimeout(this.#tagCheckTimer);
    const seq = ++this.#tagCheckSeq;
    if (PlayerModel.tagError(tag)) {
      this.view.setMessage('create', '');
      return;
    }
    this.#tagCheckTimer = setTimeout(async () => {
      try {
        const free = await this.supabase.tagAvailable(tag);
        if (seq !== this.#tagCheckSeq) return;
        this.view.setMessage('create', free ? `#${tag} is available.` : `#${tag} is already taken. Please choose another tag.`, free ? 'success' : 'error');
      } catch {
        /* ignore – checked again on submit */
      }
    }, 300);
  }

  async #create({ name, tag }) {
    const error = PlayerModel.nameError(name) ?? PlayerModel.tagError(tag);
    if (error) {
      this.view.setMessage('create', error);
      return;
    }
    this.view.setBusy('create', true);
    try {
      const profile = await this.supabase.createPlayer(PlayerModel.cleanName(name), tag);
      this.player.set(profile, profile.code);
      this.view.setMessage('create', '');
      this.view.showSaved(this.player.label, profile.code);
    } catch (err) {
      this.view.setMessage('create', describe(err, tag));
    } finally {
      this.view.setBusy('create', false);
    }
  }

  async #recover(raw) {
    const code = formatCode(raw);
    if (!code) {
      this.view.setMessage('recover', 'A recovery code looks like WR-XXXX-XXXX-XXXX-XXXX.');
      return;
    }
    this.view.setBusy('recover', true);
    try {
      const profile = await this.supabase.getPlayer(code);
      this.player.set(profile, code);
      this.view.close();
      this.toast.show(`Welcome back, ${this.player.label}!`, 'success');
    } catch (err) {
      this.view.setMessage('recover', describe(err));
    } finally {
      this.view.setBusy('recover', false);
    }
  }

  async #copyCode() {
    const ok = await copyText(this.player.code ?? '');
    this.toast.show(ok ? 'Recovery code copied.' : 'Copy failed. Please write the code down.', ok ? 'success' : 'warning');
  }

  // ------------------------------------------------------------- settings

  async #saveName(name) {
    const error = PlayerModel.nameError(name);
    if (error) {
      this.view.renderSettings(this.player, { note: error, tone: 'error' });
      return;
    }
    await this.#update(PlayerModel.cleanName(name), null, 'Name saved.');
  }

  async #saveTag(tag) {
    if (tag === this.player.tag) return;
    const error = PlayerModel.tagError(tag);
    if (error) {
      this.view.renderSettings(this.player, { note: error, tone: 'error' });
      return;
    }
    await this.#update(this.player.name, tag, `Your tag is now #${tag}.`);
  }

  async #update(name, tag, success) {
    try {
      const profile = await this.supabase.updatePlayer(this.player.code, name, tag);
      this.player.set(profile);
      this.view.renderSettings(this.player, { note: success, tone: 'success' });
    } catch (err) {
      this.view.renderSettings(this.player, { note: describe(err, tag), tone: 'error' });
    }
  }
}
