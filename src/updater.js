'use strict';

// Auto-update via electron-updater against the GitHub Releases of this repo.
//
// - Quiet background checks: 20 s after launch and every few hours. Errors are
//   logged, never shown.
// - When a newer build has downloaded: one toast in the window, "Restart"
//   (quitAndInstall) or dismiss for later (installs on next quit —
//   autoInstallOnAppQuit). If the window cannot show a toast right then (it is
//   on a provider's sign-in page, say), the old modal dialog instead.
// - Help → "Check for Updates…" runs an interactive check that reports either
//   way (up to date / downloading / could not check), also as toasts.
// - No-ops in development and in unsigned macOS builds (build-info.json is
//   written by build/afterPack.js; macOS can only install signed updates).
// - electron-updater is required lazily, at the first check, so it costs
//   nothing at startup.

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');

const INITIAL_DELAY_MS = 20 * 1000;
const INTERVAL_MS = 4 * 60 * 60 * 1000;

let autoUpdater = null;
let getWindow = () => null;
// Shows a toast; returns a falsy value when it could not (src/toasts.js).
let notify = () => null;
let interactive = false;
let promptedVersion = null;
let buildInfo = null;

function log(...args) {
  console.log('[updater]', ...args);
}

function readBuildInfo() {
  if (buildInfo) return buildInfo;
  try {
    buildInfo = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'build-info.json'), 'utf8'));
  } catch (_) {
    buildInfo = {};
  }
  return buildInfo;
}

// Why updates are unavailable, or null when they can run.
function unavailableReason() {
  if (!app.isPackaged) return 'Updates are only available in packaged builds.';
  const info = readBuildInfo();
  if (info.updatesEnabled === false || (process.platform === 'darwin' && !info.signed)) {
    return 'This build is not code-signed, so it cannot update itself. Download the latest version from the website instead.';
  }
  return null;
}

function parentWindow() {
  const win = getWindow();
  return win && !win.isDestroyed() ? win : undefined;
}

async function showMessage(options) {
  const win = parentWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

// A toast when the window can take one, the native dialog otherwise.
function tell(toast, dialogOptions) {
  if (notify(toast)) return;
  showMessage(dialogOptions).catch(() => {});
}

function restartNow() {
  setImmediate(() => autoUpdater.quitAndInstall());
}

async function promptRestart(info) {
  if (promptedVersion === info.version) return;
  promptedVersion = info.version;
  const shown = notify({
    key: 'update',
    variant: 'info',
    title: `Move ${info.version} is ready`,
    detail: 'Restart to update now, or it installs the next time you quit.',
    actions: [{ id: 'restart', label: 'Restart' }],
    dismissible: true,
    onAction: (id) => {
      if (id === 'restart') restartNow();
    },
  });
  if (shown) return;
  const { response } = await showMessage({
    type: 'info',
    title: 'Update ready',
    message: `A new version of Move (${info.version}) is ready.`,
    detail: 'Restart now to start using it, or it will be installed the next time you quit.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) restartNow();
}

function attachEvents() {
  autoUpdater.on('checking-for-update', () => log('checking'));
  autoUpdater.on('update-available', (info) => {
    log('available', info.version);
    if (interactive) {
      tell(
        {
          key: 'update',
          variant: 'info',
          title: `Downloading Move ${info.version}`,
          detail: 'You’ll be asked to restart once it’s ready.',
        },
        {
          type: 'info',
          title: 'Update available',
          message: `Move ${info.version} is available.`,
          detail: 'It is downloading in the background. You will be asked to restart once it is ready.',
          buttons: ['OK'],
          noLink: true,
        },
      );
    }
  });
  autoUpdater.on('update-not-available', (info) => {
    log('up to date', info && info.version);
    if (interactive) {
      tell(
        { key: 'update', variant: 'success', title: 'You’re up to date', detail: `Move ${app.getVersion()} is the latest version.` },
        {
          type: 'info',
          title: 'Up to date',
          message: `Move ${app.getVersion()} is the latest version.`,
          buttons: ['OK'],
          noLink: true,
        },
      );
    }
  });
  autoUpdater.on('download-progress', (progress) => log(`downloading ${Math.round(progress.percent)}%`));
  autoUpdater.on('update-downloaded', (info) => {
    log('downloaded', info.version);
    promptRestart(info);
  });
  autoUpdater.on('error', (error) => {
    log('error', error && (error.stack || error.message || error));
    if (interactive) {
      const detail = String((error && error.message) || error || 'Unknown error');
      tell(
        { key: 'update', variant: 'warning', title: 'Couldn’t check for updates', detail: `Try again later. ${detail}` },
        {
          type: 'warning',
          title: 'Could not check for updates',
          message: 'Move could not check for updates right now.',
          detail,
          buttons: ['OK'],
          noLink: true,
        },
      );
    }
  });
}

async function check({ interactiveCheck }) {
  ensureUpdater();
  interactive = interactiveCheck;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // 'error' is also emitted by electron-updater; nothing else to do here.
    log('check failed', error && error.message);
  } finally {
    // Leave the interactive flag on long enough for the result events to fire.
    if (interactiveCheck) setTimeout(() => { interactive = false; }, 15 * 1000);
  }
}

// Loads and configures electron-updater the first time it is needed.
function ensureUpdater() {
  if (autoUpdater) return;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  // Windows ships one installer per architecture. The ARM64 build is published
  // under its own update channel (latest-arm64.yml) so an ARM64 install never
  // downloads the x64 installer. electron-builder also stamps the channel into
  // app-update.yml; setting it here keeps the two from ever disagreeing.
  if (process.platform === 'win32' && process.arch === 'arm64') {
    autoUpdater.channel = 'latest-arm64';
  }
  attachEvents();
}

function start(options) {
  getWindow = options.getWindow;
  if (typeof options.notify === 'function') notify = options.notify;
  if (unavailableReason()) {
    log('disabled:', unavailableReason());
    return;
  }

  // Nothing is loaded until the first check; startup pays only for a timer.
  setTimeout(() => check({ interactiveCheck: false }), INITIAL_DELAY_MS);
  setInterval(() => check({ interactiveCheck: false }), INTERVAL_MS);
}

// Help → Check for Updates…
async function checkInteractively() {
  const reason = unavailableReason();
  if (reason) {
    tell(
      { key: 'update', variant: 'info', title: `Move ${app.getVersion()}`, detail: reason, durationMs: 8000 },
      {
        type: 'info',
        title: 'Check for Updates',
        message: `Move ${app.getVersion()}`,
        detail: reason,
        buttons: ['OK'],
        noLink: true,
      },
    );
    return;
  }
  await check({ interactiveCheck: true });
}

module.exports = { start, checkInteractively, unavailableReason, readBuildInfo };
