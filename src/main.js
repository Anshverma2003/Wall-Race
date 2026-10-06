import { AppController } from './controllers/AppController.js';

const app = new AppController();
app.init();

// Handy for debugging in the browser console.
window.wallRace = app;
