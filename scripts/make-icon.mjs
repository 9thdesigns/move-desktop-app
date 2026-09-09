// Regenerates build/icon.png (macOS, padded squircle with shadow) and
// build/icon-win.png (Windows, full-bleed) from the Move "M" mark.
//
// The mark paths in scripts/icon/*.path were traced from the site's
// 512px web-app icon (app/assets/images/favicon/web-app-manifest-512x512.png
// in m0ve-web). Rendering needs @resvg/resvg-js, which is not a project
// dependency:
//
//   npm install --no-save @resvg/resvg-js && npm run icon
//
// Without it the script still writes the SVG sources next to the paths.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const light = fs.readFileSync(path.join(here, 'icon', 'mark-light.path'), 'utf8').trim();
const gold = fs.readFileSync(path.join(here, 'icon', 'mark-gold.path'), 'utf8').trim();

// Bounding box of the mark (face + extrusion) in its 512px source space.
const BBOX = { x: 108, y: 109, w: 295, h: 295 };
const SIZE = 1024;

function markGroup(squareSize, squareOffset, ratio) {
  const s = (squareSize * ratio) / BBOX.h;
  const cx = squareOffset + squareSize / 2;
  const cy = squareOffset + squareSize / 2;
  const tx = cx - (BBOX.x + BBOX.w / 2) * s;
  const ty = cy - (BBOX.y + BBOX.h / 2) * s;
  return `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(4)})">
    <path d="${gold}" fill="#D6B72F"/>
    <path d="${light}" fill="#F4F4F2"/>
  </g>`;
}

function svg({ padded }) {
  const sq = padded ? 824 : SIZE;
  const off = padded ? 100 : 0;
  const rx = padded ? 184 : 224;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2E2E2E"/>
      <stop offset="1" stop-color="#121212"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.10"/>
      <stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
    <filter id="markShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="${off}" y="${off}" width="${sq}" height="${sq}" rx="${rx}" fill="url(#bg)"${padded ? ' filter="url(#shadow)"' : ''}/>
  <rect x="${off}" y="${off}" width="${sq}" height="${sq}" rx="${rx}" fill="url(#sheen)"/>
  <g filter="url(#markShadow)">${markGroup(sq, off, 0.58)}</g>
</svg>`;
}

let Resvg = null;
try {
  ({ Resvg } = await import('@resvg/resvg-js'));
} catch (_) {
  console.warn('@resvg/resvg-js is not installed; writing SVG sources only.');
}

for (const [name, opts] of [['icon', { padded: true }], ['icon-win', { padded: false }]]) {
  const source = svg(opts);
  fs.writeFileSync(path.join(here, 'icon', `${name}.svg`), source);
  if (!Resvg) continue;
  const png = new Resvg(source, { fitTo: { mode: 'width', value: SIZE } }).render().asPng();
  fs.writeFileSync(path.join(root, 'build', `${name}.png`), png);
  console.log(`build/${name}.png (${png.length} bytes)`);
}
