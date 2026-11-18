'use strict';

// The launch splash, laid over the main window while the site loads.
//
// Why a view over the window rather than a splash window or a page loaded
// first: the window can be shown the moment the splash's local file paints
// (tens of milliseconds), and the site starts loading in the window's own
// webContents at the same instant, in parallel. Nothing waits for anything.
// When the site's document is ready the splash fades and the view is removed,
// revealing the page that was underneath all along.
//
// What to show while waiting — loading, slow, offline — is decided by
// src/splash-state.js; this file only connects it to Electron.

const path = require('node:path');
const { WebContentsView, ipcMain } = require('electron');
const { createSplashMachine } = require('./splash-state');

const SPLASH_PAGE = path.join(__dirname, 'splash.html');
const SPLASH_PRELOAD = path.join(__dirname, 'splash-preload.js');
// Matches the .stage transition in splash.html, plus a frame of slack.
const FADE_MS = 300;

// splash webContents id → controller, so IPC can be routed (and checked).
const controllers = new Map();
let ipcInstalled = false;

function installIpc() {
  if (ipcInstalled) return;
  ipcInstalled = true;
  const route = (fn) => (event) => {
    const controller = controllers.get(event.sender.id);
    if (controller) fn(controller);
  };
  ipcMain.on('move-splash:hello', route((c) => c.sendState()));
  ipcMain.on('move-splash:retry', route((c) => c.machine.retry()));
  ipcMain.on('move-splash:online', route((c) => {
    if (c.machine.state === 'offline') c.machine.retry();
  }));
}

// Lay a splash over `win`.
//   reload()  – load the app again (Retry, or the connection came back)
//   probe()   – resolves true when the site answers; drives automatic retry
//   onPainted – called once the splash has drawn, so the window can be shown
// Returns { isActive, ready, failed, dispose }.
function attach(win, { reload, probe, onPainted, slowAfterMs, autoRetryMs } = {}) {
  installIpc();

  const view = new WebContentsView({
    webPreferences: {
      preload: SPLASH_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      transparent: true,
    },
  });
  // Transparent, so the fade-out reveals the app instead of a blank view.
  view.setBackgroundColor('#00000000');

  const contents = view.webContents;
  // The splash is a sealed local page: it never navigates or opens anything.
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const fit = () => {
    if (win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  win.contentView.addChildView(view);
  win.on('resize', fit);

  let active = true;
  let removeTimer = null;

  const controller = {
    machine: null,
    sendState() {
      if (!contents.isDestroyed() && controller.machine) contents.send('move-splash:state', controller.machine.snapshot());
    },
  };

  function remove() {
    if (removeTimer) clearTimeout(removeTimer);
    removeTimer = null;
    controllers.delete(contents.id);
    if (!win.isDestroyed()) {
      win.removeListener('resize', fit);
      try {
        win.contentView.removeChildView(view);
      } catch (_) {
        // Already gone with the window.
      }
      // The splash had keyboard focus; hand it to the page so shortcuts and
      // typing work without a click first.
      if (win.isFocused()) win.webContents.focus();
    }
    if (!contents.isDestroyed() && typeof contents.close === 'function') contents.close();
  }

  controller.machine = createSplashMachine({
    slowAfterMs,
    autoRetryMs,
    probe,
    onReload: () => reload && reload(),
    onChange: (snapshot) => {
      controller.sendState();
      if (snapshot.state === 'ready') {
        active = false;
        removeTimer = setTimeout(remove, FADE_MS);
      }
    },
  });
  controllers.set(contents.id, controller);

  let painted = false;
  const paintedOnce = () => {
    if (painted) return;
    painted = true;
    if (onPainted) onPainted();
  };
  contents.once('did-finish-load', paintedOnce);
  contents.once('did-fail-load', paintedOnce);

  contents.loadFile(SPLASH_PAGE);
  controller.machine.start();

  const dispose = () => {
    active = false;
    controller.machine.dispose();
    remove();
  };
  win.once('closed', dispose);

  return {
    isActive: () => active,
    ready: () => controller.machine.ready(),
    failed: (reason) => controller.machine.failed(reason),
    dispose,
  };
}

module.exports = { attach, SPLASH_PAGE };
