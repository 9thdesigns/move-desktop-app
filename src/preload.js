'use strict';

// The one bridge between the website and the shell. Exposed only to pages on
// the site itself (never to an OAuth provider page loaded in the window), and
// every call is validated again in the main process.
//
//   window.moveDesktop.isDesktop            – true
//   window.moveDesktop.version              – app version
//   window.moveDesktop.platform / .arch     – 'darwin' | 'win32', 'arm64' | 'x64'
//   window.moveDesktop.titleBarHeight       – height of the draggable strip
//   window.moveDesktop.openExternal(url)    – open an http(s) URL in the system browser
//   window.moveDesktop.setTitleBarOverlay({ color, symbolColor })
//                                           – recolour the Windows caption buttons
//   window.moveDesktop.setBadgeCount(n)     – unread count on the Dock / taskbar icon
//   window.moveDesktop.isFullscreen()       – whether the window is full screen
//   window.moveDesktop.onFullscreenChange(fn)
//                                           – fn(isFullscreen) on every change;
//                                             returns an unsubscribe function
//   window.moveDesktop.focusWindow()        – bring this window to the front
//                                             (a notification click calls it)
//
// For CSS, the same state is mirrored onto <html>, which survives Turbo visits:
//
//   html[data-desktop-fullscreen="true"]    – full screen: on macOS the traffic
//                                             lights are gone, so the inset the
//                                             page keeps for them can collapse
//   html.move-desktop                       – any page inside the app
//   window 'move-desktop:fullscreen' event  – detail: { isFullscreen }
//
// It also installs the window's drag strip (installDragStrip), draws the
// shell's toasts (installToasts) and reports connectivity changes so the shell
// can show its offline banner.

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('move:app-info');

function isAppHost(hostname) {
  return hostname === info.appHost || hostname.endsWith(`.${info.appHost}`);
}

// ---------------------------------------------------------------------------
// The Windows taskbar badge
// ---------------------------------------------------------------------------
//
// macOS draws its own numeric Dock badge from a count; Windows has no such
// thing, only a small icon overlaid on the taskbar button — so on Windows the
// number has to be painted. This is where it happens, because a sandboxed
// preload can reach a canvas and the main process cannot. The main process gets
// a PNG data URL back and hands it to nativeImage (src/badge.js).
//
// Windows asks for 16x16; drawn at 32 so it stays sharp on a scaled display.
// The cap lives here rather than in src/badge.js — a sandboxed preload can only
// require `electron` and a handful of node builtins, never a file of ours — and
// it applies to the drawing alone: the Dock takes the real number.
const BADGE_MAX = 99;
const BADGE_SIZE = 32;

function badgeLabel(count) {
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

function drawBadgeOverlay(count) {
  const canvas = document.createElement('canvas');
  canvas.width = BADGE_SIZE;
  canvas.height = BADGE_SIZE;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const center = BADGE_SIZE / 2;
  ctx.fillStyle = '#dc2626';
  ctx.beginPath();
  ctx.arc(center, center, center, 0, Math.PI * 2);
  ctx.fill();

  const label = badgeLabel(count);
  // Three glyphs ("99+") need the room two do not.
  const fontSize = label.length >= 3 ? 15 : label.length === 2 ? 19 : 22;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // A hair below centre: digits sit visually high in their em box.
  ctx.fillText(label, center, center + 1);

  return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Full screen
// ---------------------------------------------------------------------------

let fullscreen = Boolean(info && info.isFullscreen);
const fullscreenListeners = new Set();

function reflectFullscreen() {
  const root = document.documentElement;
  if (!root) return;
  root.classList.add('move-desktop');
  root.setAttribute('data-desktop-fullscreen', fullscreen ? 'true' : 'false');
}

ipcRenderer.on('move:fullscreen', (_event, value) => {
  const next = Boolean(value);
  if (next === fullscreen) return;
  fullscreen = next;
  reflectFullscreen();
  for (const listener of fullscreenListeners) {
    try {
      listener(fullscreen);
    } catch (_) {
      // A page listener throwing must not stop the others.
    }
  }
  window.dispatchEvent(new CustomEvent('move-desktop:fullscreen', { detail: { isFullscreen: fullscreen } }));
});

if (document.documentElement) reflectFullscreen();
document.addEventListener('DOMContentLoaded', reflectFullscreen, { once: true });

// ---------------------------------------------------------------------------
// Notifications: a click brings the window forward
// ---------------------------------------------------------------------------
//
// Clicking a web Notification fires its `click` event in the page and nothing
// else: Electron does not raise the window, and on Windows nothing else does
// either. Wrap the page's Notification constructor so every notification it
// creates also focuses the window when clicked. The subclass keeps
// `instanceof Notification`, `permission` and `requestPermission` working,
// and if anything about the wrap fails the page keeps the original.

function wrapNotificationsInMainWorld() {
  if (!contextBridge.executeInMainWorld) return;
  try {
    contextBridge.executeInMainWorld({
      func: (focus) => {
        const Native = window.Notification;
        if (typeof Native !== 'function' || Native.__moveDesktopWrapped) return;
        class MoveNotification extends Native {
          constructor(title, options) {
            super(title, options);
            this.addEventListener('click', () => {
              try {
                focus();
              } catch (_) {
                // Never let our handler break the page's.
              }
            });
          }
        }
        Object.defineProperty(MoveNotification, 'permission', { get: () => Native.permission });
        Object.defineProperty(MoveNotification, 'maxActions', { get: () => Native.maxActions });
        MoveNotification.requestPermission = (...args) => Native.requestPermission(...args);
        Object.defineProperty(MoveNotification, '__moveDesktopWrapped', { value: true });
        window.Notification = MoveNotification;
      },
      args: [() => ipcRenderer.send('move:focus-window')],
    });
  } catch (_) {
    // Older runtime or a page that froze Notification: leave it alone.
  }
}

// ---------------------------------------------------------------------------
// Menu commands that belong to the page
// ---------------------------------------------------------------------------
//
// Search is the site's own Cmd/Ctrl+K (see src/shortcuts.js). Choosing it from
// the menu sends the page that keystroke; if nothing on the page takes it,
// go to the search page instead.

function runPageCommand(command) {
  if (!command || command.name !== 'search') return;
  const mac = info.platform === 'darwin';
  const keydown = new KeyboardEvent('keydown', {
    key: 'k',
    code: 'KeyK',
    metaKey: mac,
    ctrlKey: !mac,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement || document.body || document).dispatchEvent(keydown);
  if (!keydown.defaultPrevented && typeof command.fallbackPath === 'string' && command.fallbackPath.startsWith('/')) {
    window.location.assign(new URL(command.fallbackPath, window.location.origin).href);
  }
}

if (info && isAppHost(window.location.hostname)) {
  wrapNotificationsInMainWorld();
  ipcRenderer.on('move:command', (_event, command) => runPageCommand(command));
  // The shell's offline banner. `navigator.onLine` only knows about the
  // network interface, which is exactly the "you dropped off the Wi-Fi" case
  // the banner is for; a site outage still ends on the offline page.
  window.addEventListener('offline', () => ipcRenderer.send('move:connectivity', false));
  window.addEventListener('online', () => ipcRenderer.send('move:connectivity', true));

  contextBridge.exposeInMainWorld('moveDesktop', {
    isDesktop: true,
    version: info.version,
    platform: info.platform,
    arch: info.arch,
    titleBarHeight: info.titleBarHeight,
    openExternal: (url) => ipcRenderer.invoke('move:open-external', String(url)),
    setTitleBarOverlay: (options) => ipcRenderer.invoke('move:set-titlebar-overlay', options || {}),
    setBadgeCount: (count) => {
      const value = Number(count);
      const badge = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
      let overlay = null;
      if (info.platform === 'win32' && badge > 0) {
        try {
          overlay = drawBadgeOverlay(badge);
        } catch (_) {
          // No canvas, no overlay — the main process clears rather than leaving
          // a stale number on the taskbar.
        }
      }
      return ipcRenderer.invoke('move:set-badge-count', { count: badge, overlay });
    },
    isFullscreen: () => fullscreen,
    onFullscreenChange: (listener) => {
      if (typeof listener !== 'function') return () => {};
      fullscreenListeners.add(listener);
      return () => fullscreenListeners.delete(listener);
    },
    focusWindow: () => ipcRenderer.send('move:focus-window'),
  });
}

// ---------------------------------------------------------------------------
// The drag strip
// ---------------------------------------------------------------------------
//
// A chromeless window has no title bar for the OS to drag by, so the page has
// to donate a strip marked `-webkit-app-region: drag`. The site draws one on
// every layout that renders shared/_desktop_chrome — but "the page provides
// it" is a promise the shell cannot keep on its own, and every gap in it is a
// window the user cannot move:
//
//   * the bundled offline page and any layout without the partial,
//   * a provider's sign-in page, which the main window navigates to in place
//     for an OAuth round trip,
//   * a page whose own chrome — a modal backdrop, a toast, a drag preview —
//     paints over the strip: a draggable region is resolved in paint order,
//     so whatever stacks on top takes the drag with it.
//
// So the shell installs its own. It is transparent and exactly as tall as the
// strip the site reserves space for, so where the site already draws one this
// sits invisibly on top of it; where the site draws nothing, it is the only
// thing keeping the window movable. It is re-attached as the last child of
// <body> after every navigation, because paint order is what decides the
// region and Turbo replaces <body> wholesale on a visit.
//
// Framed windows (Linux, and anything else that keeps a native title bar) get
// none of this: `chromeless` is false and the OS handles dragging itself.

const DRAG_STRIP_ID = 'move-desktop-drag-strip';
const DRAG_STYLE_ID = 'move-desktop-drag-style';

function dragStripCss(height) {
  return `
    /* The site's own strip (shared/_desktop_chrome) out-ranks every overlay on
       the page, so a modal or a toast can never take the drag with it. */
    .desktop-titlebar { z-index: 2147483647 !important; }

    #${DRAG_STRIP_ID} {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: ${height}px;
      z-index: 2147483647;
      background: transparent;
      -webkit-app-region: drag;
      -webkit-user-select: none;
      user-select: none;
    }

    /* The window controls are drawn by the OS over the page (traffic lights on
       macOS, the Window Controls Overlay on Windows), so nothing here has to
       leave room for them. Anything ever placed inside the strip stays
       clickable. */
    #${DRAG_STRIP_ID} * { -webkit-app-region: no-drag; }
  `;
}

function installDragStrip(height) {
  let bodyObserver = null;
  let lastPointerDown = 0;

  const ensureStyle = () => {
    const root = document.head || document.documentElement;
    if (!root || document.getElementById(DRAG_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = DRAG_STYLE_ID;
    style.textContent = dragStripCss(height);
    root.appendChild(style);
  };

  const ensureStrip = () => {
    const body = document.body;
    if (!body) return;
    const strip = document.getElementById(DRAG_STRIP_ID) || document.createElement('div');
    strip.id = DRAG_STRIP_ID;
    strip.setAttribute('aria-hidden', 'true');

    // A page with no strip at all has nothing to interrupt: put it in.
    if (!strip.isConnected) {
      body.appendChild(strip);
      return;
    }

    // Beyond that the strip wants to be the LAST child. Two elements that both
    // reach the top of the stack are separated by document order, so a strip
    // that stays put while the page appends over it is a strip that a toast or
    // a modal can eventually stack above. Re-appending something already last
    // is a no-op, which is also what keeps the observer below from looping.
    //
    // Except mid-drag: moving the element re-enters layout, and re-entering
    // layout under the cursor is how a drag already in flight gets cancelled.
    // A press anywhere buys a second of stillness — a timestamp rather than a
    // flag, so a press whose release the page never sees (the window server
    // swallows it once it takes over the drag) cannot wedge this off for good.
    if (Date.now() - lastPointerDown < 1000) return;
    if (body.lastElementChild !== strip) body.appendChild(strip);
  };

  const ensure = () => {
    ensureStyle();
    ensureStrip();
    // <body> is a different element after a Turbo visit; the observer has to
    // follow it.
    if (document.body && bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver.observe(document.body, { childList: true });
    }
  };

  const start = () => {
    if (typeof MutationObserver === 'function') {
      bodyObserver = new MutationObserver(ensure);
      // A replaced <body> is a childList change on <html>.
      new MutationObserver(ensure).observe(document.documentElement, { childList: true });
    }
    ensure();
  };

  for (const event of ['pointerdown', 'mousedown']) {
    window.addEventListener(event, () => { lastPointerDown = Date.now(); }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // Belt and braces for the cases a MutationObserver does not see as a change:
  // a restored back/forward cache entry, and Turbo's own render events.
  for (const event of ['pageshow', 'turbo:load', 'turbo:render']) {
    window.addEventListener(event, ensure);
  }
}

if (info && info.chromeless) installDragStrip(info.titleBarHeight);

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
//
// The shell's own notices (update ready, offline, errors) as toasts in the
// page rather than modal dialogs. The main process decides what is on screen
// and for how long (src/toast-queue.js) and sends the whole list on every
// change; this draws it. The treatment follows the Configure My AI flash
// toasts — bottom-right stack, 240 ms rise in, 180 ms fall out, an icon per
// variant, a close button, hover to hold — in Move's colours.
//
// Everything lives in a shadow root on a host attached to <html> rather than
// <body>: the page's CSS cannot reach in, ours cannot leak out, and Turbo
// replacing <body> on a visit does not take the stack with it. Text is only
// ever set through textContent.

const TOAST_HOST_ID = 'move-desktop-toasts';
const TOAST_LEAVE_MS = 180;

// Same glyphs as the reference: stroked, 20px grid.
const TOAST_ICONS = {
  success: [['circle', { cx: 10, cy: 10, r: 7.5 }], ['path', { d: 'M6.8 10.2l2.2 2.2 4.2-4.6' }]],
  error: [['circle', { cx: 10, cy: 10, r: 7.5 }], ['path', { d: 'M10 6.5v4.2M10 13.4v.1' }]],
  warning: [['path', { d: 'M10 3.2l7.3 12.8H2.7z' }], ['path', { d: 'M10 8.3v3.6M10 14v.1' }]],
  info: [['circle', { cx: 10, cy: 10, r: 7.5 }], ['path', { d: 'M10 9.2v4.3M10 6.6v.1' }]],
};

const TOAST_CSS = `
  :host { all: initial; }
  .region {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 2147483646;
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    width: min(380px, calc(100vw - 48px));
    pointer-events: none;
    font-family: "FixelText", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;

    --surface: #ffffff;
    --ink: #1f1f1f;
    --ink-2: #787774;
    --line: rgba(55, 53, 47, 0.12);
    --fill-2: rgba(55, 53, 47, 0.06);
    --focus: rgba(55, 53, 47, 0.55);
    --shadow: 0 0 0 1px rgba(55, 53, 47, 0.06), 0 12px 32px -12px rgba(0, 25, 53, 0.28), 0 2px 6px -2px rgba(0, 25, 53, 0.06);
    --c-success: #2f9d5c;
    --c-error: #d94f4a;
    --c-warning: #d9730d;
    --c-info: #2383e2;
  }
  :host([data-theme="dark"]) .region {
    --surface: #232326;
    --ink: rgba(255, 255, 255, 0.86);
    --ink-2: rgba(255, 255, 255, 0.6);
    --line: rgba(255, 255, 255, 0.1);
    --fill-2: rgba(255, 255, 255, 0.07);
    --focus: rgba(255, 255, 255, 0.6);
    --shadow: 0 0 0 1px rgba(255, 255, 255, 0.06), 0 12px 32px -12px rgba(0, 0, 0, 0.7);
    --c-success: #45bda9;
    --c-error: #f07a7a;
    --c-warning: #e89b52;
    --c-info: #5ba8f5;
  }
  .toast {
    pointer-events: auto;
    box-sizing: border-box;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 12px 12px 12px 14px;
    background: var(--surface);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow);
    font-size: 13.5px;
    line-height: 1.4;
    -webkit-app-region: no-drag;
    animation: toast-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .toast.is-leaving { animation: toast-out 180ms ease-in both; pointer-events: none; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } }
  @keyframes toast-out { to { opacity: 0; transform: translateY(4px) scale(0.98); } }
  .icon { flex: none; width: 18px; height: 18px; margin-top: 1px; color: var(--icon); }
  .icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; display: block; }
  .toast--success { --icon: var(--c-success); }
  .toast--error { --icon: var(--c-error); }
  .toast--warning { --icon: var(--c-warning); }
  .toast--info { --icon: var(--c-info); }
  .text { flex: 1; min-width: 0; }
  .title { font-weight: 600; letter-spacing: -0.005em; }
  .detail { color: var(--ink-2); margin-top: 1px; overflow-wrap: anywhere; }
  .act {
    flex: none;
    height: 28px;
    padding: 0 10px;
    margin-top: -4px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 550;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .act:hover { background: var(--fill-2); }
  .act:active { transform: scale(0.97); }
  .x {
    flex: none;
    width: 24px;
    height: 24px;
    margin: -3px -4px 0 0;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--ink-2);
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .x:hover { background: var(--fill-2); color: var(--ink); }
  .x svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 1.6; fill: none; stroke-linecap: round; }
  .act:focus-visible, .x:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    .toast { animation: toast-fade 120ms linear both; }
    .toast.is-leaving { animation: toast-fade 120ms linear reverse both; }
    @keyframes toast-fade { from { opacity: 0; } }
  }
  @media (max-width: 640px) {
    .region { left: 12px; right: 12px; bottom: 12px; width: auto; }
  }
`;

function svgElement(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

function pageIsDark() {
  const root = document.documentElement;
  if (root) {
    const theme = root.getAttribute('data-theme');
    if (root.classList.contains('dark') || theme === 'dark') return true;
    if (root.classList.contains('light') || theme === 'light') return false;
  }
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function installToasts() {
  let host = null;
  let region = null;
  const send = (type, id, extra) => ipcRenderer.send('move:toast-event', { type, id, ...extra });

  const ensureHost = () => {
    const root = document.documentElement;
    if (!root) return null;
    if (host && host.isConnected) return region;
    host = document.getElementById(TOAST_HOST_ID) || document.createElement('div');
    host.id = TOAST_HOST_ID;
    if (!host.shadowRoot) {
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = TOAST_CSS;
      region = document.createElement('div');
      region.className = 'region';
      region.setAttribute('aria-live', 'polite');
      shadow.append(style, region);
    } else {
      region = host.shadowRoot.querySelector('.region');
    }
    root.appendChild(host);
    return region;
  };

  const build = (toast) => {
    const el = document.createElement('div');
    el.className = `toast toast--${toast.variant}`;
    el.dataset.id = toast.id;
    el.setAttribute('role', toast.role === 'alert' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.setAttribute('aria-hidden', 'true');
    const svg = svgElement('svg', { viewBox: '0 0 20 20' });
    for (const [tag, attrs] of TOAST_ICONS[toast.variant] || TOAST_ICONS.info) svg.appendChild(svgElement(tag, attrs));
    icon.appendChild(svg);

    const text = document.createElement('div');
    text.className = 'text';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = toast.title;
    text.appendChild(title);
    if (toast.detail) {
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = toast.detail;
      text.appendChild(detail);
    }
    el.append(icon, text);

    for (const action of toast.actions || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'act';
      button.textContent = action.label;
      button.addEventListener('click', () => send('action', toast.id, { actionId: action.id }));
      el.appendChild(button);
    }

    if (toast.dismissible) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'x';
      close.setAttribute('aria-label', 'Dismiss');
      const x = svgElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
      x.appendChild(svgElement('path', { d: 'M4.5 4.5l7 7m0-7l-7 7' }));
      close.appendChild(x);
      close.addEventListener('click', () => send('dismiss', toast.id));
      el.appendChild(close);
    }

    // Hover or keyboard focus holds the countdown, as in the reference.
    el.addEventListener('mouseenter', () => send('pause', toast.id));
    el.addEventListener('mouseleave', () => send('resume', toast.id));
    el.addEventListener('focusin', () => send('pause', toast.id));
    el.addEventListener('focusout', (event) => {
      if (!el.contains(event.relatedTarget)) send('resume', toast.id);
    });
    return el;
  };

  const leave = (el) => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), TOAST_LEAVE_MS);
  };

  const render = (list) => {
    if (!Array.isArray(list)) return;
    const target = ensureHost();
    if (!target) return;
    host.setAttribute('data-theme', pageIsDark() ? 'dark' : 'light');

    const wanted = new Set(list.map((toast) => toast.id));
    for (const el of target.querySelectorAll('.toast:not(.is-leaving)')) {
      if (!wanted.has(el.dataset.id)) leave(el);
    }
    // DOM order is oldest first; the region's column-reverse stacks the newest
    // on top. A new toast goes in front of the next one already drawn, so a
    // replacement (same key) lands in the slot of the toast it replaces.
    list.forEach((toast, index) => {
      if (target.querySelector(`.toast[data-id="${toast.id}"]`)) return;
      const el = build(toast);
      let before = null;
      for (const later of list.slice(index + 1)) {
        before = target.querySelector(`.toast[data-id="${later.id}"]`);
        if (before) break;
      }
      target.insertBefore(el, before);
    });
  };

  ipcRenderer.on('move:toasts', (_event, list) => {
    if (document.documentElement) render(list);
    else document.addEventListener('DOMContentLoaded', () => render(list), { once: true });
  });
}

// The site, and the bundled offline page (the only file: page this window
// can ever show; the navigation policy refuses every other file: URL).
if (info && (isAppHost(window.location.hostname) || window.location.protocol === 'file:')) installToasts();
