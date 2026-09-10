// Regenerates build/icon.png (macOS, padded squircle with shadow) and
// build/icon-win.png (Windows, full-bleed rounded square) from the Move "M"
// mark: a black M with a pale-gold copy of itself offset up and to the right,
// on white.
//
// The geometry below was measured from the site's 512px web-app icon
// (app/assets/images/favicon/web-app-manifest-512x512.png in m0ve-web) and
// redrawn as exact polygons, so the edges are crisp at every size. Rendering
// needs @resvg/resvg-js, which is not a project dependency:
//
//   npm install --no-save @resvg/resvg-js && npm run icon
//
// Without it the script still writes the SVG sources to scripts/icon/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// --- The mark, in the 512px coordinate space of the source icon ------------
//
// Three pieces: the V (both arms, joined at the bottom), the left stem, and
// the right bar. The stem is separated from the left arm by a diagonal slit
// and the right bar from the right arm by a vertical one; both slits are
// simply the gaps between the pieces. Every diagonal edge has the same slope.
const SLOPE = 0.45; // horizontal run per unit of vertical rise
const TOP = 116.5;
const BOTTOM = 404.5;

const V = [
  [110, TOP], // left arm, top-left
  [186.5, TOP], // left arm, top-right
  [245, 246], // inner vertex where the arms meet
  [291.5, 144], // right arm tip (sits below the top of the bar)
  [291.5, 285], // right arm: vertical edge ends, diagonal begins
  [239.5, BOTTOM], // the point of the V
];
const STEM = [
  [108, 146],
  [177, 146 + 69 / SLOPE], // diagonal top edge, parallel to the arm
  [177, BOTTOM],
  [108, BOTTOM],
];
const BAR = [
  [303, TOP],
  [376, TOP],
  [376, BOTTOM],
  [303, BOTTOM],
];
const GOLD_OFFSET = [28, -8];

const INK = '#000000';
// The source draws the gold layer at 50% opacity over white; this is that
// colour, flattened, so nothing depends on compositing order.
const GOLD = '#EADA96';

// Bounding box of face + gold layer in the 512px space.
const BBOX = {
  x: 108,
  y: TOP + GOLD_OFFSET[1],
  w: 376 + GOLD_OFFSET[0] - 108,
  h: BOTTOM - (TOP + GOLD_OFFSET[1]),
};
const SIZE = 1024;

const poly = (points) => `<polygon points="${points.map(([x, y]) => `${x},${y}`).join(' ')}"/>`;
const pieces = () => [V, STEM, BAR].map(poly).join('');

function markGroup(squareSize, squareOffset, ratio) {
  const s = (squareSize * ratio) / BBOX.h;
  const cx = squareOffset + squareSize / 2;
  const cy = squareOffset + squareSize / 2;
  const tx = cx - (BBOX.x + BBOX.w / 2) * s;
  const ty = cy - (BBOX.y + BBOX.h / 2) * s;
  return `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(4)})">
    <g fill="${GOLD}" transform="translate(${GOLD_OFFSET[0]} ${GOLD_OFFSET[1]})">${pieces()}</g>
    <g fill="${INK}">${pieces()}</g>
  </g>`;
}

function svg({ padded }) {
  const sq = padded ? 824 : SIZE;
  const off = padded ? 100 : 0;
  const rx = padded ? 184 : 224;
  // A hairline keeps the white tile readable on white backgrounds (Finder
  // in light mode, Explorer). It is 4px at 1024px, so it disappears at
  // small sizes rather than turning into a dark outline.
  const hair = 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect x="${off}" y="${off}" width="${sq}" height="${sq}" rx="${rx}" fill="#FFFFFF"${padded ? ' filter="url(#shadow)"' : ''}/>
  ${markGroup(sq, off, 0.58)}
  <rect x="${off + hair / 2}" y="${off + hair / 2}" width="${sq - hair}" height="${sq - hair}" rx="${rx - hair / 2}" fill="none" stroke="#000000" stroke-opacity="0.08" stroke-width="${hair}"/>
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
