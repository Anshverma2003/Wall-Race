import { GameController } from './GameController.js';
import { RoomController } from './RoomController.js';
import { SettingsController } from './SettingsController.js';
import { RoomModel } from '../models/RoomModel.js';
import { SettingsModel } from '../models/SettingsModel.js';
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
    this.settingsCtrl = new SettingsController({ settings: this.settings, room: this.room, view: settingsView });

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

    this.gameCtrl = new GameController({
      roomCtrl: this.roomCtrl,
      room: this.room,
      settings: this.settings,
      view: gameView,
      modal: this.modal,
      toast: this.toast,
    });
    this.roomCtrl.setGameController(this.gameCtrl);

    lobbyView.on('edit-settings', () => this.settingsCtrl.open());
  }

  init() {
    this.settingsCtrl.init();
    this.roomCtrl.init();
    this.gameCtrl.init();

    // Cross-controller reactions
    this.roomCtrl.on('change', () => this.settingsCtrl.refresh());
    this.settings.on('change', (keys) => {
      if (keys.includes('gridSize') || keys.includes('wallLimit')) this.roomCtrl.onMatchSettingsChanged();
      if (keys.includes('flipBoard')) this.gameCtrl.refresh();
    });

    this.showScreen('home');
  }

  /** @param {'home'|'lobby'|'game'} name */
  showScreen(name) {
    this.screens.show(name);
  }
}
