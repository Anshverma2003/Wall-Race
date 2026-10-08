import { AIController } from './AIController.js';
import { GameController } from './GameController.js';
import { LeaderboardController } from './LeaderboardController.js';
import { ProfileController } from './ProfileController.js';
import { RoomController } from './RoomController.js';
import { SettingsController } from './SettingsController.js';
import { PlayerModel } from '../models/PlayerModel.js';
import { RoomModel } from '../models/RoomModel.js';
import { SettingsModel } from '../models/SettingsModel.js';
import { AIService } from '../services/AIService.js';
import { PeerService } from '../services/PeerService.js';
import { ResultsService } from '../services/ResultsService.js';
import { StorageService } from '../services/StorageService.js';
import { SupabaseService } from '../services/SupabaseService.js';
import { GameView } from '../views/GameView.js';
import { HomeView } from '../views/HomeView.js';
import { LeaderboardView } from '../views/LeaderboardView.js';
import { LobbyView } from '../views/LobbyView.js';
import { ModalView } from '../views/ModalView.js';
import { ProfileView } from '../views/ProfileView.js';
import { ScreenView } from '../views/ScreenView.js';
import { SettingsView } from '../views/SettingsView.js';
import { ToastView } from '../views/ToastView.js';

/**
 * Composition root: creates models, services, views and controllers,
 * wires them together and owns top-level navigation.
 */
export class AppController {
  constructor() {
    // Services & models
    this.storage = new StorageService();
    this.network = new PeerService();
    this.aiService = new AIService();
    this.supabase = new SupabaseService();
    this.settings = new SettingsModel(this.storage);
    this.room = new RoomModel();
    this.player = new PlayerModel(this.storage);
    this.results = new ResultsService(this.storage, this.player);

    // Views
    this.screens = new ScreenView();
    this.modal = new ModalView();
    this.toast = new ToastView();
    const homeView = new HomeView();
    const lobbyView = new LobbyView();
    const gameView = new GameView();
    const settingsView = new SettingsView();

    // Controllers
    const getSession = () => this.session;

    this.settingsCtrl = new SettingsController({ settings: this.settings, getSession, view: settingsView });

    this.profileCtrl = new ProfileController({
      player: this.player,
      supabase: this.supabase,
      view: new ProfileView(),
      settingsCtrl: this.settingsCtrl,
      toast: this.toast,
    });

    this.roomCtrl = new RoomController({
      app: this,
      room: this.room,
      settings: this.settings,
      storage: this.storage,
      network: this.network,
      homeView,
      lobbyView,
      modal: this.modal,
      toast: this.toast,
      player: this.player,
      supabase: this.supabase,
      results: this.results,
    });

    this.aiCtrl = new AIController({
      app: this,
      settings: this.settings,
      storage: this.storage,
      aiService: this.aiService,
      homeView,
      results: this.results,
      toast: this.toast,
    });

    this.gameCtrl = new GameController({
      getSession,
      settings: this.settings,
      view: gameView,
      modal: this.modal,
      toast: this.toast,
    });
    this.roomCtrl.setGameController(this.gameCtrl);
    this.aiCtrl.setGameController(this.gameCtrl);

    this.leaderboardCtrl = new LeaderboardController({
      app: this,
      supabase: this.supabase,
      player: this.player,
      view: new LeaderboardView(),
      homeButton: document.getElementById('btn-open-leaderboard'),
    });

    lobbyView.on('edit-settings', () => this.settingsCtrl.open());
  }

  /** The game session currently on screen: a vs-AI game or the online room. */
  get session() {
    return this.aiCtrl.isActive ? this.aiCtrl : this.roomCtrl;
  }

  init() {
    this.showScreen('home');
    this.settingsCtrl.init();
    // Asks for a name#tag on first open, refreshes the saved profile otherwise.
    this.profileCtrl.init();
    // An online session (refresh mid-match) takes priority over a stored vs-AI game.
    const canResumeAi = !this.roomCtrl.hasStoredSession;
    this.roomCtrl.init();
    this.gameCtrl.init();
    this.aiCtrl.init({ canResume: canResumeAi });
    this.leaderboardCtrl.init();

    // Cross-controller reactions
    this.roomCtrl.on('change', () => this.settingsCtrl.refresh());
    this.roomCtrl.on('rated', () => this.profileCtrl.refresh());
    this.aiCtrl.on('change', () => this.settingsCtrl.refresh());
    this.settings.on('change', (keys) => {
      if (keys.includes('gridSize') || keys.includes('wallLimit')) this.roomCtrl.onMatchSettingsChanged();
      if (keys.includes('flipBoard')) this.gameCtrl.refresh();
    });

    // Results that could not be sent last time (offline, server hiccup).
    if (this.player.exists) this.results.flushPending();
  }

  /** @param {'home'|'lobby'|'game'|'leaderboard'} name */
  showScreen(name) {
    this.screens.show(name);
  }
}
