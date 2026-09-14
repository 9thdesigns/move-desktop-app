'use strict';

// The unread count on the app's icon.
//
// The site knows the number; only the shell can draw it, and the two operating
// systems disagree about what "it" is:
//
//   macOS — the Dock tile carries a real numeric badge, app-wide. `setBadgeCount`
//           is all it takes, and the number survives the window being hidden,
//           which is the whole point: the badge is what tells the user something
//           arrived while they were somewhere else.
//   Windows — there is no numeric badge. The taskbar button takes a 16x16 icon
//           overlaid on the app's own, per window, and whatever the number is has
//           to be painted into that image. The preload draws it (it is the only
//           side of the bridge with a canvas) and sends the PNG over; this module
//           only decides whether to show it.
//   Linux — `setBadgeCount` works under the Unity launcher and is a no-op
//           everywhere else. Harmless either way.
//
// The count arrives from web content, so nothing here trusts it: the number is
// normalised and the image is checked to be a PNG data URL of a sane size before
// it reaches nativeImage.

// A PNG data URL and nothing else. The preload is the only thing that should be
// producing these, but this is the boundary where page-supplied data becomes an
// OS-level image, so it is checked rather than assumed.
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

// A 32x32 badge is a couple of kB. Anything approaching this is not one.
const MAX_OVERLAY_CHARS = 64 * 1024;

// Whatever the page sent → a count we are willing to show. Rubbish, negatives
// and fractions all come back as 0, which is also how the badge is cleared.
function normalizeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

// The taskbar overlay's accessible name — read out by a screen reader, so it
// says the real number rather than the "99+" painted into the icon.
function describeCount(count) {
  return count === 1 ? '1 unread item' : `${count} unread items`;
}

function decodeOverlay(nativeImage, dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_OVERLAY_CHARS) return null;
  if (!PNG_DATA_URL.test(dataUrl)) return null;
  const image = nativeImage.createFromDataURL(dataUrl);
  return image && !image.isEmpty() ? image : null;
}

// Put `count` on the icon. Returns the number actually applied.
function apply({ app, win, nativeImage, platform = process.platform, count, overlayDataUrl }) {
  const value = normalizeCount(count);

  // No-op on Windows, and on a Linux desktop without Unity.
  if (app && typeof app.setBadgeCount === 'function') app.setBadgeCount(value);

  if (platform === 'win32' && win && !win.isDestroyed()) {
    // A count with no usable image would otherwise leave the previous overlay
    // sitting there saying the wrong number, so a failed draw clears instead.
    const image = value > 0 ? decodeOverlay(nativeImage, overlayDataUrl) : null;
    win.setOverlayIcon(image, image ? describeCount(value) : '');
  }

  return value;
}

module.exports = { apply, normalizeCount, describeCount, MAX_OVERLAY_CHARS };
