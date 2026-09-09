'use strict';

// Lock down what web content may ask the OS for. Only these permissions are
// ever granted, and only to pages on the site itself (never to an OAuth
// provider page that happens to be loaded in the window).
//
//   notifications              – in-app notifications
//   fullscreen                 – video / focus mode
//   media                      – microphone & camera for huddles and voice channels
//   clipboard-sanitized-write  – "Copy link" buttons (navigator.clipboard.writeText)
const ALLOWED_PERMISSIONS = new Set(['notifications', 'fullscreen', 'media', 'clipboard-sanitized-write']);

function install(session, { isAppUrl, desktopCapturer }) {
  const allowed = (permission, url) => ALLOWED_PERMISSIONS.has(permission) && isAppUrl(url);

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (webContents && !webContents.isDestroyed() ? webContents.getURL() : '');
    callback(allowed(permission, url));
  });

  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const url = requestingOrigin || (details && details.requestingUrl) || '';
    return allowed(permission, url);
  });

  // Screen sharing (getDisplayMedia). Chromium has no built-in picker inside
  // Electron, so use the OS picker where one exists (macOS 15+) and fall back
  // to the primary screen elsewhere. Only pages on the site may ask.
  if (typeof session.setDisplayMediaRequestHandler === 'function' && desktopCapturer) {
    session.setDisplayMediaRequestHandler(
      (request, callback) => {
        const frameUrl = request && request.frame && request.frame.url;
        if (!isAppUrl(frameUrl)) {
          callback({});
          return;
        }
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => {
            if (sources.length === 0) return callback({});
            return callback({ video: sources[0], audio: 'loopback' });
          })
          .catch(() => callback({}));
      },
      { useSystemPicker: true },
    );
  }
}

module.exports = { install, ALLOWED_PERMISSIONS };
