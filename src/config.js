'use strict';

// Everything the shell knows about the product lives here. The app has no
// product logic of its own: it is a window around APP_URL, and these values
// are the only thing that ties the two together.
const APP_NAME = 'Move';
const APP_ID = 'app.m0ve.desktop';
const PRODUCTION_URL = 'https://m0ve.app';
const START_PATH = '/welcome';

// Appended to Chromium's real user agent, e.g. "… Chrome/144.0.0.0 Electron/44.3.0 Safari/537.36 Move-Desktop/0.1.0".
// The Rails app keys its desktop experience off this token (`desktop_app?`).
const UA_MARKER_PREFIX = 'Move-Desktop/';

// Custom URL scheme the website uses to bring the user back into the app after
// a flow that had to run in the system browser (Google OAuth, for example):
//   move-desktop://open?path=/calendars/42
const PROTOCOL_SCHEME = 'move-desktop';

// Height of the draggable strip the website renders under the traffic lights
// (macOS) / caption buttons (Windows). Keep in sync with the Rails side.
const TITLEBAR_HEIGHT = 38;

// Window background and Windows caption-button colours before the page paints,
// per system theme: the same paper and ink the splash and the site use
// (move/tokens.css in m0ve-web), so a launch or a resize never flashes white
// on a dark desktop. The site recolours the caption buttons to its own
// background once it loads (desktop_titlebar_controller → setTitleBarOverlay).
const THEME = Object.freeze({
  light: Object.freeze({ background: '#fbfbfa', symbol: '#37352f' }),
  dark: Object.freeze({ background: '#191919', symbol: '#e9e9e7' }),
});

function themeColors(dark) {
  return dark ? THEME.dark : THEME.light;
}

const HELP_URL = 'https://docs.m0ve.app';
const RELEASES_URL = 'https://github.com/9thdesigns/move-desktop-app/releases';

// In development the shell can point at a local Rails server:
//   MOVE_DESKTOP_URL=http://localhost:3000 npm start
// Packaged builds always use production, whatever the environment says.
function resolveAppUrl({ isPackaged }) {
  const override = process.env.MOVE_DESKTOP_URL;
  if (!isPackaged && override) {
    try {
      const url = new URL(override);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch (_) {
      // fall through to production
    }
  }
  return PRODUCTION_URL;
}

module.exports = {
  APP_NAME,
  APP_ID,
  PRODUCTION_URL,
  START_PATH,
  UA_MARKER_PREFIX,
  PROTOCOL_SCHEME,
  TITLEBAR_HEIGHT,
  THEME,
  themeColors,
  HELP_URL,
  RELEASES_URL,
  resolveAppUrl,
};
