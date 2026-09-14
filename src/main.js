'use strict';

// Move for desktop: a thin Electron shell around https://m0ve.app.
//
// The main process does only these jobs:
//   1. open the site on /welcome and remember the window's bounds
//   2. enforce the navigation policy (src/navigation.js)
//   3. identify itself with a user-agent marker the site keys off
//   4. fall back to a bundled offline page when the site can't be reached
//   5. draw a chromeless window with native controls on each OS
//   6. grant only a short permission allowlist, only to the site
//   7. keep itself updated (src/updater.js)
//   8. provide a native menu bar (src/menu.js)
//   9. show the site's unread count on the app icon (src/badge.js)
// plus the deep link (move-desktop://) that brings the user back after a flow
// that had to run in the system browser.

const path = require('node:path');
const { app, BrowserWindow, Menu, session, shell, ipcMain, screen, desktopCapturer, net, clipboard, nativeImage } = require('electron');

const config = require('./config');
const { createPolicy, isOpenableExternally } = require('./navigation');
const windowState = require('./window-state');
const permissions = require('./permissions');
const deepLinks = require('./deep-links');
const updater = require('./updater');
const menu = require('./menu');
const badge = require('./badge');

const APP_ORIGIN = config.resolveAppUrl({ isPackaged: app.isPackaged });
const policy = createPolicy({ appOrigin: APP_ORIGIN });
const START_URL = `${APP_ORIGIN}${config.START_PATH}`;
const OFFLINE_PAGE = path.join(__dirname, 'offline.html');
const DEEP_LINK = { scheme: config.PROTOCOL_SCHEME };

// Let the site's notification chimes play without a click first.
//
// Chromium gates audio on user activation, and a browser tab nearly always has
// it — you clicked a link to get to the page. This window often does not: it
// can sit untouched since launch, or be brought forward from the Dock or with
// Cmd-Tab, and none of that is a gesture the page sees. A message or huddle
// arriving in that state had its play() rejected, which is exactly the state
// the user is in when the sound is the only thing that would tell them.
//
// `autoplayPolicy` in webPreferences is documented to default to this already,
// but it has been reported not to take effect since Electron 5 — setting it
// there changes nothing. The command line switch does apply, and it has to be
// appended before `ready`.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let pendingDeepLink = null;
// webContents → last site URL it showed, so the offline page knows where to retry.
const lastAppUrl = new WeakMap();
// BrowserWindow → reconnect timer while its offline page is showing.
const reconnectTimers = new WeakMap();

// ---------------------------------------------------------------------------
// Single instance + custom URL scheme (must be set up before `ready`)
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    focusMainWindow();
    const link = deepLinks.findDeepLinkInArgv(argv, DEEP_LINK);
    if (link) handleDeepLink(link);
  });

  if (process.defaultApp && process.platform === 'win32' && process.argv.length >= 2) {
    // Running from `electron .` on Windows: register with the script path so
    // the link launches this checkout rather than a bare Electron binary.
    app.setAsDefaultProtocolClient(config.PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(config.PROTOCOL_SCHEME);
  }

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  if (process.platform === 'win32') app.setAppUserModelId(config.APP_ID);

  app.whenReady().then(onReady);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// Chromeless, but not frameless: the OS keeps resize edges and its own window
// controls, and the site renders a draggable strip under them.
function titleBarOptions() {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } };
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#f2f2f2', symbolColor: '#171717', height: config.TITLEBAR_HEIGHT },
    };
  }
  return {};
}

// Whether the windows this app opens have a native title bar to drag by. They
// do not on macOS or Windows, which is why the page has to donate a draggable
// strip; the preload reads this and installs one. Derived from the options
// above rather than repeating the platform test, so the two cannot drift.
const CHROMELESS = Object.keys(titleBarOptions()).length > 0;

function windowOptions(bounds) {
  return {
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: config.APP_NAME,
    backgroundColor: '#f2f2f2',
    icon: process.platform === 'linux' ? path.join(__dirname, '..', 'build', 'icon.png') : undefined,
    ...titleBarOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Chromium starves timers in a window it considers background —
      // minimised, or fully covered by another app — and clamps intervals to
      // about once a minute. That is precisely when the site's unread poll
      // matters most: the window is away but the Dock badge the user is looking
      // at comes from it. The cost is a page that keeps running while hidden,
      // which is what this app is for.
      backgroundThrottling: false,
    },
  };
}

function createWindow({ url, restoreState }) {
  const state = restoreState ? windowState.restore({ app, screen }) : { ...windowState.DEFAULT_SIZE };
  const win = new BrowserWindow(windowOptions(state));
  if (state.isMaximized) win.maximize();
  if (restoreState) windowState.track(win, { app });
  attachWindow(win);
  win.loadURL(url);
  return win;
}

function attachWindow(win) {
  const show = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once('ready-to-show', show);
  // Never leave the user staring at nothing on a slow network.
  setTimeout(show, 2500);

  const contents = win.webContents;

  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation we cancelled or the user superseded.
    if (!isMainFrame || errorCode === -3) return;
    if (typeof validatedUrl === 'string' && validatedUrl.startsWith('file:')) return;
    showOffline(win, validatedUrl, `${errorDescription} (${errorCode})`);
  });

  const remember = (_event, url) => {
    if (policy.isAppUrl(url)) lastAppUrl.set(contents, url);
  };
  contents.on('did-navigate', remember);
  contents.on('did-navigate-in-page', remember);

  contents.on('context-menu', (_event, params) => showContextMenu(win, params));

  // Mouse back/forward buttons (Windows, Linux).
  win.on('app-command', (_event, command) => {
    if (command === 'browser-backward') contents.navigationHistory.goBack();
    if (command === 'browser-forward') contents.navigationHistory.goForward();
  });

  win.on('closed', () => {
    clearReconnect(win);
    if (win === mainWindow) mainWindow = null;
  });
}

function currentWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) return focused;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return BrowserWindow.getAllWindows()[0] || null;
}

function focusMainWindow() {
  const win = currentWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openInApp(pathname, { newWindow = false } = {}) {
  const url = `${APP_ORIGIN}${pathname}`;
  const win = currentWindow();
  if (newWindow || !win) {
    const created = createWindow({ url, restoreState: !win });
    if (!mainWindow) mainWindow = created;
    return;
  }
  win.loadURL(url);
  focusMainWindow();
}

// ---------------------------------------------------------------------------
// Navigation policy — applied to every webContents the app ever creates
// ---------------------------------------------------------------------------

function enforce(event, url) {
  const verdict = policy.classify(url);
  if (verdict.action === 'app') return;
  event.preventDefault();
  if (verdict.action === 'external') shell.openExternal(url);
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => enforce(event, url));
  // Server-side redirects don't fire will-navigate, so a site link that
  // 302s to another host goes through here.
  contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame === false) return;
    enforce(event, url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    const verdict = policy.classify(url);
    if (verdict.action === 'app') {
      // A target="_blank" link on the site opens a second app window that
      // shares the session, like a new tab would.
      return { action: 'allow', overrideBrowserWindowOptions: windowOptions({ width: 1100, height: 760 }) };
    }
    if (verdict.action === 'external') shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (childWindow) => attachWindow(childWindow));
});

// ---------------------------------------------------------------------------
// Offline fallback
// ---------------------------------------------------------------------------

function showOffline(win, failedUrl, reason) {
  const target = policy.isAppUrl(failedUrl) ? failedUrl : lastAppUrl.get(win.webContents) || START_URL;
  win.loadFile(OFFLINE_PAGE, { query: { url: target, origin: APP_ORIGIN, reason } });
  scheduleReconnect(win, target);
}

async function siteReachable() {
  try {
    const response = await net.fetch(`${APP_ORIGIN}/up`, { cache: 'no-store' });
    return response.status < 500;
  } catch (_) {
    return false;
  }
}

function clearReconnect(win) {
  const timer = reconnectTimers.get(win);
  if (timer) clearInterval(timer);
  reconnectTimers.delete(win);
}

function scheduleReconnect(win, target) {
  clearReconnect(win);
  const timer = setInterval(async () => {
    if (win.isDestroyed()) return clearReconnect(win);
    // The user already navigated away from the offline page.
    if (!win.webContents.getURL().startsWith('file:')) return clearReconnect(win);
    if (await siteReachable()) {
      clearReconnect(win);
      if (!win.isDestroyed()) win.loadURL(target);
    }
    return undefined;
  }, 5000);
  reconnectTimers.set(win, timer);
}

// ---------------------------------------------------------------------------
// Deep links: move-desktop://open?path=/…
// ---------------------------------------------------------------------------

function handleDeepLink(rawUrl) {
  const link = deepLinks.parseDeepLink(rawUrl, DEEP_LINK);
  if (!link) return;
  if (!app.isReady() || !currentWindow()) {
    pendingDeepLink = link;
    return;
  }
  openInApp(link.path);
}

// ---------------------------------------------------------------------------
// Context menu (Electron has none by default)
// ---------------------------------------------------------------------------

function showContextMenu(win, params) {
  const template = [];
  const contents = win.webContents;

  if (params.linkURL) {
    if (isOpenableExternally(params.linkURL)) {
      template.push({ label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) });
    }
    template.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
  }

  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      template.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    template.push(
      {
        label: 'Add to Dictionary',
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
      { type: 'separator' },
    );
  }

  if (params.isEditable) {
    template.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  } else if (params.selectionText) {
    template.push({ role: 'copy' });
  }

  if (params.mediaType === 'image' && params.srcURL) {
    template.push({ type: 'separator' }, { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) });
  }

  if (!app.isPackaged) {
    template.push({ type: 'separator' }, { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) });
  }

  while (template.length && template[0].type === 'separator') template.shift();
  while (template.length && template[template.length - 1].type === 'separator') template.pop();
  if (template.length === 0) return;

  Menu.buildFromTemplate(template).popup({ window: win });
}

// ---------------------------------------------------------------------------
// IPC for the preload bridge (src/preload.js). Every handler re-checks that the
// caller is a page on the site.
// ---------------------------------------------------------------------------

function fromAppPage(event) {
  const frame = event.senderFrame;
  const url = frame && !frame.isDestroyed?.() ? frame.url : event.sender.getURL();
  return policy.isAppUrl(url);
}

function hexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function registerIpc() {
  ipcMain.on('move:app-info', (event) => {
    event.returnValue = {
      appHost: policy.appHost,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      titleBarHeight: config.TITLEBAR_HEIGHT,
      chromeless: CHROMELESS,
    };
  });

  ipcMain.handle('move:open-external', (event, url) => {
    if (!fromAppPage(event) || !isOpenableExternally(url)) return false;
    shell.openExternal(url);
    return true;
  });

  // The unread count, pushed by the site whenever it changes. On Windows the
  // page's preload has already drawn the taskbar overlay; on macOS the number
  // is all the Dock needs. Both go through src/badge.js.
  ipcMain.handle('move:set-badge-count', (event, payload) => {
    if (!fromAppPage(event)) return false;
    badge.apply({
      app,
      win: BrowserWindow.fromWebContents(event.sender),
      nativeImage,
      count: payload && payload.count,
      overlayDataUrl: payload && payload.overlay,
    });
    return true;
  });

  ipcMain.handle('move:set-titlebar-overlay', (event, options) => {
    if (!fromAppPage(event) || process.platform !== 'win32') return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    const color = hexColor(options && options.color);
    const symbolColor = hexColor(options && options.symbolColor);
    if (!win || !color || !symbolColor) return false;
    win.setTitleBarOverlay({ color, symbolColor, height: config.TITLEBAR_HEIGHT });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function onReady() {
  // Identify as the desktop app without touching the real Chrome UA.
  app.userAgentFallback = `${app.userAgentFallback} ${config.UA_MARKER_PREFIX}${app.getVersion()}`;

  permissions.install(session.defaultSession, { isAppUrl: policy.isAppUrl, desktopCapturer });
  registerIpc();
  menu.build({
    getWindow: currentWindow,
    goHome: ({ newWindow }) => openInApp('/', { newWindow }),
    openInApp: (pathname) => openInApp(pathname),
    checkForUpdates: () => updater.checkInteractively(),
  });

  mainWindow = createWindow({ url: START_URL, restoreState: true });

  // Launched by a deep link (Windows passes it in argv; macOS via open-url).
  const argvLink = deepLinks.findDeepLinkInArgv(process.argv, DEEP_LINK);
  if (argvLink) handleDeepLink(argvLink);
  if (pendingDeepLink) {
    openInApp(pendingDeepLink.path);
    pendingDeepLink = null;
  }

  updater.start({ getWindow: currentWindow });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow({ url: START_URL, restoreState: true });
  } else {
    focusMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
