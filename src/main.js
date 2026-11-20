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
//  10. a launch splash over the window while the site loads (src/splash.js)
//  11. its own notices as toasts in the page (src/toasts.js)
// plus the deep link (move-desktop://) that brings the user back after a flow
// that had to run in the system browser.
//
// Startup order matters for how fast the window appears: the window and its
// splash are created first thing in `ready`, the site starts loading at the
// same moment, and nothing else (menu, updater) stands in front of either.
// The updater does not even load electron-updater until its first check.

const path = require('node:path');
const { app, BrowserWindow, Menu, session, shell, ipcMain, screen, desktopCapturer, net, clipboard, nativeImage, nativeTheme } = require('electron');

const config = require('./config');
const { createPolicy, isOpenableExternally } = require('./navigation');
const windowState = require('./window-state');
const permissions = require('./permissions');
const deepLinks = require('./deep-links');
const updater = require('./updater');
const menu = require('./menu');
const badge = require('./badge');
const splash = require('./splash');
const toasts = require('./toasts');
const { SEARCH_PATH } = require('./shortcuts');

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
// BrowserWindow → its launch splash (src/splash.js), while one exists.
const splashes = new WeakMap();
// Windows that just came back from the offline page and owe a "Back online".
const reconnected = new WeakSet();

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

const isDark = () => nativeTheme.shouldUseDarkColors;

// Chromeless, but not frameless: the OS keeps resize edges and its own window
// controls, and the site renders a draggable strip under them. On macOS the
// traffic lights sit centred in that 38px strip; on Windows the caption
// buttons are a Window Controls Overlay exactly as tall as it, so nothing the
// page draws below the strip is ever under a native control.
function titleBarOptions(dark = false) {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } };
  }
  if (process.platform === 'win32') {
    const colors = config.themeColors(dark);
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: colors.background, symbolColor: colors.symbol, height: config.TITLEBAR_HEIGHT },
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
  const dark = isDark();
  return {
    ...bounds,
    minWidth: windowState.MIN_SIZE.width,
    minHeight: windowState.MIN_SIZE.height,
    show: false,
    title: config.APP_NAME,
    // The system theme's paper, so the first frame and any resize gap match
    // the splash and the site instead of flashing white on a dark desktop.
    backgroundColor: config.themeColors(dark).background,
    // macOS: the green button and Ctrl+Cmd+F enter a native full-screen Space.
    fullscreenable: true,
    icon: process.platform === 'linux' ? path.join(__dirname, '..', 'build', 'icon.png') : undefined,
    ...titleBarOptions(dark),
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

// `withSplash`: lay the launch splash over the window and show it as soon as
// the splash paints, while the site loads underneath. Used for the main
// window; extra windows open on a warm session and skip it.
function createWindow({ url, restoreState, withSplash = false }) {
  const state = restoreState ? windowState.restore({ app, screen }) : { ...windowState.DEFAULT_SIZE };
  const win = new BrowserWindow(windowOptions(state));
  if (state.isMaximized) win.maximize();
  if (restoreState) windowState.track(win, { app });
  attachWindow(win);
  if (withSplash) {
    splashes.set(
      win,
      splash.attach(win, {
        reload: () => {
          if (!win.isDestroyed()) win.loadURL(lastAppUrl.get(win.webContents) || url);
        },
        probe: siteReachable,
        onPainted: () => showWindow(win),
      }),
    );
    // Even if the splash itself somehow never paints.
    setTimeout(() => showWindow(win), 600);
  }
  win.loadURL(url);
  return win;
}

function showWindow(win) {
  if (!win.isDestroyed() && !win.isVisible()) win.show();
}

function splashActive(win) {
  const overlay = splashes.get(win);
  return Boolean(overlay && overlay.isActive());
}

function attachWindow(win) {
  win.once('ready-to-show', () => showWindow(win));
  // Never leave the user staring at nothing on a slow network.
  setTimeout(() => showWindow(win), 2500);

  const contents = win.webContents;

  // Whether the main frame has failed since its last load began. Chromium can
  // report the error page it then shows as a finished document, which must
  // not count as "the app is ready" and dismiss the splash.
  let failedSinceStart = false;
  contents.on('did-start-loading', () => {
    failedSinceStart = false;
  });

  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation we cancelled or the user superseded.
    if (!isMainFrame || errorCode === -3) return;
    if (typeof validatedUrl === 'string' && validatedUrl.startsWith('file:')) return;
    failedSinceStart = true;
    if (policy.isAppUrl(validatedUrl)) lastAppUrl.set(contents, validatedUrl);
    // First launch: the splash shows its own offline state and keeps retrying.
    if (splashActive(win)) {
      splashes.get(win).failed(`${errorDescription} (${errorCode})`);
      return;
    }
    showOffline(win, validatedUrl, `${errorDescription} (${errorCode})`);
  });

  // The splash goes the moment the site's document is ready — DOMContentLoaded,
  // not the last image — and a page that came back from the offline screen
  // says so.
  const onDocumentReady = () => {
    const url = contents.getURL();
    if (failedSinceStart || !url || url.startsWith('file:') || policy.classify(url).action !== 'app') return;
    if (splashActive(win)) splashes.get(win).ready();
    if (reconnected.has(win) && policy.isAppUrl(url)) {
      reconnected.delete(win);
      toasts.show(win, { key: 'connectivity', variant: 'success', title: 'Back online', detail: 'Move reconnected.' });
    }
  };
  contents.on('dom-ready', onDocumentReady);
  contents.on('did-finish-load', onDocumentReady);

  const remember = (_event, url) => {
    if (policy.isAppUrl(url)) lastAppUrl.set(contents, url);
  };
  contents.on('did-navigate', remember);
  contents.on('did-navigate-in-page', remember);

  // Full screen, for the page: on macOS the traffic lights disappear with it,
  // so the inset the site keeps for them can collapse (src/preload.js).
  const sendFullscreen = () => {
    if (!contents.isDestroyed()) contents.send('move:fullscreen', win.isFullScreen());
  };
  win.on('enter-full-screen', sendFullscreen);
  win.on('leave-full-screen', sendFullscreen);

  // Coming back to the window (Cmd-Tab, the Dock, a notification) should put
  // the keyboard straight into the page, not leave it with nothing focused.
  win.on('focus', () => {
    if (splashActive(win) || contents.isDestroyed() || contents.isDevToolsFocused()) return;
    contents.focus();
  });

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

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function focusMainWindow() {
  focusWindow(currentWindow());
}

// The one way anything here hands a URL to the OS: http, https and mailto
// only (src/navigation.js), and a failure is a toast rather than silence.
function openExternal(url) {
  if (!isOpenableExternally(url)) return false;
  shell.openExternal(url).catch((error) => {
    console.warn('[shell] openExternal failed', error && error.message);
    toasts.show(currentWindow(), {
      variant: 'error',
      title: 'Couldn’t open the link',
      detail: 'Your system has no app set up to open it.',
    });
  });
  return true;
}

// Menu → Search: the site's own Cmd/Ctrl+K when the page is ours (see
// src/shortcuts.js), the search page otherwise.
function runSearch() {
  const win = currentWindow();
  if (win && policy.isAppUrl(win.webContents.getURL())) {
    win.webContents.send('move:command', { name: 'search', fallbackPath: SEARCH_PATH });
    focusWindow(win);
    return;
  }
  openInApp(SEARCH_PATH);
}

function openInApp(pathname, { newWindow = false } = {}) {
  const url = `${APP_ORIGIN}${pathname}`;
  const win = currentWindow();
  if (newWindow || !win) {
    const created = createWindow({ url, restoreState: !win, withSplash: !win });
    if (!mainWindow) mainWindow = created;
    return;
  }
  win.loadURL(url);
  focusMainWindow();
}

// ---------------------------------------------------------------------------
// Navigation policy — applied to every webContents the app ever creates
// ---------------------------------------------------------------------------

function enforce(event, url, verdict = policy.classify(url)) {
  if (verdict.action === 'app') return true;
  event.preventDefault();
  if (verdict.action === 'external') openExternal(url);
  return false;
}

// Where each webContents' current main-frame navigation is, so a redirect can
// be judged by the hop it comes from (see classifyRedirect).
const navigationUrl = new WeakMap();

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => enforce(event, url));
  contents.on('did-start-navigation', (details) => {
    if (details && details.isMainFrame && !details.isSameDocument) navigationUrl.set(contents, details.url);
  });
  // Server-side redirects don't fire will-navigate, so a site link that
  // 302s to another host goes through here. One hop from the site's own file
  // routes to the storage host stays in-app; sub-frames (the file viewer's
  // iframe) are not policed here, as before.
  contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame === false) return;
    if (enforce(event, url, policy.classifyRedirect(navigationUrl.get(contents), url))) navigationUrl.set(contents, url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    const verdict = policy.classify(url);
    if (verdict.action === 'app') {
      // A target="_blank" link on the site opens a second app window that
      // shares the session, like a new tab would.
      return { action: 'allow', overrideBrowserWindowOptions: windowOptions({ width: 1100, height: 760 }) };
    }
    if (verdict.action === 'external') openExternal(url);
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
      if (!win.isDestroyed()) {
        reconnected.add(win);
        win.loadURL(target);
      }
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
      const label = params.linkURL.startsWith('mailto:') ? 'Send Email' : 'Open Link in Browser';
      template.push({ label, click: () => openExternal(params.linkURL) });
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
      isFullscreen: Boolean(BrowserWindow.fromWebContents(event.sender)?.isFullScreen()),
    };
  });

  ipcMain.handle('move:open-external', (event, url) => {
    if (!fromAppPage(event)) return false;
    return openExternal(url);
  });

  // A notification from the page was clicked (see the Notification wrap in
  // src/preload.js), or the site asked to be brought forward.
  ipcMain.on('move:focus-window', (event) => {
    if (!fromAppPage(event)) return;
    focusWindow(BrowserWindow.fromWebContents(event.sender));
  });

  // The page's network interface went away or came back: the offline banner.
  ipcMain.on('move:connectivity', (event, online) => {
    if (!fromAppPage(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (online) {
      if (toasts.dismissKey(win, 'connectivity')) {
        toasts.show(win, { key: 'connectivity', variant: 'success', title: 'Back online', detail: 'You’re connected again.' });
      }
      return;
    }
    toasts.show(win, {
      key: 'connectivity',
      variant: 'warning',
      title: 'You’re offline',
      detail: 'Changes may not save until your connection is back.',
      dismissible: true,
    });
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

// Follow the system theme: window backgrounds always, and the Windows caption
// buttons only while the shell's own pages are showing — once the site has
// loaded it owns their colours (desktop_titlebar_controller).
function applySystemTheme() {
  const colors = config.themeColors(isDark());
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(colors.background);
    if (process.platform !== 'win32') continue;
    const url = win.webContents.getURL();
    if (splashActive(win) || !url || url.startsWith('file:')) {
      win.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbol, height: config.TITLEBAR_HEIGHT });
    }
  }
}

function onReady() {
  // Identify as the desktop app without touching the real Chrome UA.
  app.userAgentFallback = `${app.userAgentFallback} ${config.UA_MARKER_PREFIX}${app.getVersion()}`;

  permissions.install(session.defaultSession, { isAppUrl: policy.isAppUrl, desktopCapturer });
  registerIpc();
  toasts.install({
    ipcMain,
    // The site, and the bundled offline page; never a provider's page.
    isToastPage: (url) => policy.isAppUrl(url) || (typeof url === 'string' && url.startsWith('file:')),
  });

  // The window (and its splash) first: everything below can wait a frame.
  mainWindow = createWindow({ url: START_URL, restoreState: true, withSplash: true });

  menu.build({
    getWindow: currentWindow,
    goHome: ({ newWindow }) => openInApp('/', { newWindow }),
    openInApp: (pathname) => openInApp(pathname),
    openExternal,
    search: runSearch,
    checkForUpdates: () => updater.checkInteractively(),
  });
  nativeTheme.on('updated', applySystemTheme);

  // Launched by a deep link (Windows passes it in argv; macOS via open-url).
  const argvLink = deepLinks.findDeepLinkInArgv(process.argv, DEEP_LINK);
  if (argvLink) handleDeepLink(argvLink);
  if (pendingDeepLink) {
    openInApp(pendingDeepLink.path);
    pendingDeepLink = null;
  }

  updater.start({
    getWindow: currentWindow,
    // Update notices as toasts; the updater falls back to a dialog when the
    // window cannot show one (it is on a provider's page, or there is none).
    notify: (options) => toasts.show(currentWindow(), options),
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow({ url: START_URL, restoreState: true, withSplash: true });
  } else {
    focusMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
