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
//
// It also installs the window's drag strip — see installDragStrip below.

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

if (info && isAppHost(window.location.hostname)) {
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
