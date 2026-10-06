import { AIController } from './AIController.js';
import { GameController } from './GameController.js';
import { RoomController } from './RoomController.js';
import { SettingsController } from './SettingsController.js';
import { RoomModel } from '../models/RoomModel.js';
import { SettingsModel } from '../models/SettingsModel.js';
import { AIService } from '../services/AIService.js';
import { PeerService } from '../services/PeerService.js';
import { StorageService } from '../services/StorageService.js';
import { GameView } from '../views/GameView.js';
import { HomeView } from '../views/HomeView.js';
import { LobbyView } from '../views/LobbyView.js';
import { ModalView } from '../views/ModalView.js';
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
    this.settings = new SettingsModel(this.storage);
    this.room = new RoomModel();

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
    });

    this.aiCtrl = new AIController({
      app: this,
      settings: this.settings,
      storage: this.storage,
      aiService: this.aiService,
      homeView,
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

    lobbyView.on('edit-settings', () => this.settingsCtrl.open());
  }

  /** The game session currently on screen: a vs-AI game or the online room. */
  get session() {
    return this.aiCtrl.isActive ? this.aiCtrl : this.roomCtrl;
  }

  init() {
    this.showScreen('home');
    this.settingsCtrl.init();
    // An online session (refresh mid-match) takes priority over a stored vs-AI game.
    const canResumeAi = !this.roomCtrl.hasStoredSession;
    this.roomCtrl.init();
    this.gameCtrl.init();
    this.aiCtrl.init({ canResume: canResumeAi });

    // Cross-controller reactions
    this.roomCtrl.on('change', () => this.settingsCtrl.refresh());
    this.aiCtrl.on('change', () => this.settingsCtrl.refresh());
    this.settings.on('change', (keys) => {
      if (keys.includes('gridSize') || keys.includes('wallLimit')) this.roomCtrl.onMatchSettingsChanged();
      if (keys.includes('flipBoard')) this.gameCtrl.refresh();
    });
  }

  /** @param {'home'|'lobby'|'game'} name */
  showScreen(name) {
    this.screens.show(name);
  }
}
