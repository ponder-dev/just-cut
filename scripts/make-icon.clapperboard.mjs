/*
 * KEPT ON PURPOSE, NOT IN USE.
 *
 * This is the clapperboard, carried over from SubSmash and corrected onto the
 * real superellipse tile. It is destined for Just Edit, the suite, rather than
 * for this tool, so it lives here as the record of that artwork until Just Edit
 * exists to take it. Nothing builds from this file.
 *
 * The icon this tool actually ships is drawn by make-icon.mjs beside it.
 */

// Generates build/icon.svg.
//
// The subject is a clapperboard with the stick hinged open, carried over from
// the private app Just Cut was carved out of. It is kept deliberately: a
// clapperboard is an object with weight rather than a pictogram, it belongs to
// nobody else the way a play triangle or a skip glyph does, and it already sat
// beside Just JPEG's photo card and Just Fits' press as one of the family.
//
// What changed is everything underneath it. The old artwork was a static SVG
// with three faults, all in the tile rather than the subject:
//
//   1. The tile was <rect rx="202">, a circular-arc rounded rectangle. The
//      house tile is a superellipse of exponent 5, which is roughly what macOS
//      uses. A circular arc reads as subtly wrong next to real Mac icons and
//      nobody can say why.
//   2. The tile was 832 inside a 1024 canvas. It should be 824. Eight pixels
//      sounds like nothing, but filling more of the canvas is exactly what
//      makes an icon look oversized in a Dock full of correct ones.
//   3. The lit top edge was on the tile, as a sheen gradient, where neither
//      Just JPEG nor Just Fits has one. The light belongs on the object: a
//      #ffffff top edge at about 18 percent is what stops the slate body
//      reading as a flat sticker.
//
// It is generated from code rather than hand-kept as SVG for the same reason
// nothing else here is trapped in a binary. The tile geometry, the gradient
// and every part of the board are parameters below, so changing the house
// gradient or the board's proportions is an edit to a number, not surgery on
// a path string.
//
//   node scripts/make-icon.mjs && electron scripts/icons.cjs && ./scripts/make-icns.sh

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANVAS = 1024;
const ART = 824;
const N = 5;

/*
 * The house gradient, shared with the PonderDev mark and with every other tool
 * icon. It is the one thing that makes a row of these read as a set rather
 * than as three apps that happen to be purple, so it is copied character for
 * character from the tool sheet and is not to be nudged.
 */
const GRADIENT = { from: '#6d8bff', to: '#8a5cf6' };

/*
 * The board's coordinates were drawn against the old 832 tile, so they are
 * kept in that space and mapped onto the real one rather than being rewritten.
 * The point of that is legibility of the source: the numbers below can still
 * be read against the original artwork, and the whole difference between the
 * two tiles lives in one transform instead of being smeared through forty
 * hand-adjusted values.
 *
 * The nudge recentres it. Measured on the rendered original, the board's
 * bounding box sits about 11 left of centre and about 8 high, because the
 * stick swings up and to the right when it opens and nothing compensated for
 * it. On a tile with real corners that lean is visible.
 */
const DESIGN_TILE = 832;
const NUDGE_X = 11;
const NUDGE_Y = 8;

/*
 * How much of the tile the board is allowed to take. Rendered at 16 beside the
 * other two, the board at its inherited size ran almost to the tile's corners,
 * so there was no blue left between the object and the edge and the whole
 * thing lost its outline. Just JPEG's card spans about 60 percent of the tile
 * and Just Fits' press about 68. This brings the board from 71 down to about
 * 63, which is what buys back the margin.
 */
const SHRINK = 0.9;
const SCALE = (ART / DESIGN_TILE) * SHRINK;

/*
 * The board itself. Three or four fat shapes is the whole budget, because the
 * icon has to survive 16 pixels in a Finder list, and the sizes here are set
 * by what actually stayed legible when rendered down rather than by what
 * looked balanced at 1024.
 */
const BOARD = {
  // The slate: the dark body everything else sits on or against.
  body: { x: 222, y: 452, w: 580, h: 330, r: 42 },

  /*
   * The lit top edge on the slate: #ffffff at 18 percent, fading to nothing
   * over the depth below. A flat band of it was the first attempt and it read
   * as a paler lid bolted to the top of the board, because a hard bottom line
   * is a thing light does not have. Fading it keeps the prescribed 18 at the
   * lip, where the eye actually reads the edge, and lets it go.
   */
  litEdge: { depth: 46, color: '#ffffff', opacity: 0.18 },

  /*
   * The writing on the slate. Three fat rows, and the warm one leads, which is
   * the accent the tool sheet asks every icon to carry so the eye has
   * somewhere to land.
   *
   * The original had four thinner rows in two pairs. At 32 pixels the pairs
   * closed into one grey smear and at 16 they were noise, so the lower pair
   * became a single wider row and every row got fatter. The faintest of the
   * four, a short bar at 28 percent white, is gone rather than thickened: it
   * was never visible below about 64 pixels, and detail that only works at
   * 1024 is detail that is lying to you.
   */
  rows: [
    { x: 268, y: 522, w: 300, h: 72, fill: '#ffd93d', opacity: 1 },
    { x: 596, y: 522, w: 160, h: 72, fill: '#ffffff', opacity: 0.92 },
    { x: 268, y: 634, w: 320, h: 64, fill: '#ffffff', opacity: 0.5 },
  ],

  // The stick, and the hinge it swings on. Eleven degrees is enough to read as
  // open without the tip running out of tile.
  stick: { x: 222, y: 330, w: 580, h: 118, r: 32, fill: '#f4f4f8' },
  hinge: { x: 244, y: 420, angle: -11 },

  /*
   * The diagonal bars on the stick. Each is a parallelogram leaning the same
   * way, cut off by the stick's own outline.
   *
   * Three, not the original four, and the light gaps are now slightly wider
   * than the dark bars. Four bars averaged out to a single grey diagonal at 16
   * pixels, which put the stick at nearly the same value as the slate under it
   * and lost the hinge entirely. Biasing towards the light keeps the stick
   * reading as a pale bar with ticks on it, which is both what a clapper looks
   * like and what survives being three pixels tall.
   */
  stripes: { count: 3, pitch: 232, width: 108, lean: 82, fill: '#23232e' },

  /*
   * The shadow under the board. Neither of the other two tools has one, so it
   * is the one liberty this icon takes, and it earns it: the board is the only
   * object in the family with a part hinged up off the tile, and without a
   * shadow it lies flat on the gradient like a decal.
   *
   * It is much smaller than the one it inherited. At 22 of blur the shadow was
   * wider than the blue margin at 16 pixels, so it filled in the gap between
   * the board and the tile edge and cost the silhouette exactly the definition
   * the margin had been bought to give it.
   */
  shadow: { dy: 12, blur: 15, color: '#140d38', opacity: 0.3 },
};

/** Superellipse |x/a|^n + |y/b|^n = 1, sampled densely enough to look smooth. */
function squirclePath(cx, cy, radius, exponent, steps = 720) {
  const points = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = cx + radius * Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
    const y = cy + radius * Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
}

/**
 * The stripes on the stick, as leaning parallelograms. Their leaning bottoms
 * run out past both ends of the stick on purpose; the stick's own outline is
 * what decides where they stop, so the ends look cut rather than drawn to fit.
 */
function stripePaths({ x, y, h }, { count, pitch, width, lean }) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const left = x + i * pitch;
    bars.push(`M${left} ${y} l${width} 0 -${lean} ${h} -${width} 0 z`);
  }
  return bars;
}

const rows = BOARD.rows
  .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" ` +
              `rx="${r.h / 2}" fill="${r.fill}" opacity="${r.opacity}"/>`)
  .join('\n        ');

const stripes = stripePaths(BOARD.stick, BOARD.stripes)
  .map((d) => `<path d="${d}"/>`)
  .join('\n          ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${GRADIENT.from}"/>
      <stop offset="1" stop-color="${GRADIENT.to}"/>
    </linearGradient>
    <!-- The slate is the only genuinely dark object in the family. It gets a
         gradient of its own so it has a direction of light rather than being a
         hole cut in the tile. -->
    <linearGradient id="slate" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#3a3a47"/>
      <stop offset="1" stop-color="#1b1b24"/>
    </linearGradient>
    <linearGradient id="lit" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BOARD.litEdge.color}" stop-opacity="${BOARD.litEdge.opacity}"/>
      <stop offset="1" stop-color="${BOARD.litEdge.color}" stop-opacity="0"/>
    </linearGradient>
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${BOARD.shadow.dy}" stdDeviation="${BOARD.shadow.blur}" flood-color="${BOARD.shadow.color}" flood-opacity="${BOARD.shadow.opacity}"/>
    </filter>
    <!-- Keeps the rows and the lit edge inside the slate's rounded corners. -->
    <clipPath id="bodyClip">
      <rect x="${BOARD.body.x}" y="${BOARD.body.y}" width="${BOARD.body.w}" height="${BOARD.body.h}" rx="${BOARD.body.r}"/>
    </clipPath>
    <!-- Trims the stripes to the stick. It lives inside the rotated group, so
         it turns with the stick and the two ends always agree. The original
         clipped to an upright rectangle instead, which sliced a flat corner
         off the raised end of the stick. -->
    <clipPath id="stickClip">
      <rect x="${BOARD.stick.x}" y="${BOARD.stick.y}" width="${BOARD.stick.w}" height="${BOARD.stick.h}" rx="${BOARD.stick.r}"/>
    </clipPath>
  </defs>

  <path d="${squirclePath(CANVAS / 2, CANVAS / 2, ART / 2, N)}" fill="url(#bg)"/>

  <g transform="translate(${CANVAS / 2} ${CANVAS / 2}) scale(${SCALE.toFixed(6)}) translate(${-CANVAS / 2 + NUDGE_X} ${-CANVAS / 2 + NUDGE_Y})" filter="url(#drop)">
    <rect x="${BOARD.body.x}" y="${BOARD.body.y}" width="${BOARD.body.w}" height="${BOARD.body.h}" rx="${BOARD.body.r}" fill="url(#slate)"/>

    <g clip-path="url(#bodyClip)">
      <!-- The lit edge, first, because it is part of the slate rather than
           something sitting on it. -->
      <rect x="${BOARD.body.x}" y="${BOARD.body.y}" width="${BOARD.body.w}" height="${BOARD.litEdge.depth}" fill="url(#lit)"/>
      ${rows}
    </g>

    <g transform="rotate(${BOARD.hinge.angle} ${BOARD.hinge.x} ${BOARD.hinge.y})">
      <rect x="${BOARD.stick.x}" y="${BOARD.stick.y}" width="${BOARD.stick.w}" height="${BOARD.stick.h}" rx="${BOARD.stick.r}" fill="${BOARD.stick.fill}"/>
      <g clip-path="url(#stickClip)" fill="${BOARD.stripes.fill}">
          ${stripes}
      </g>
    </g>
  </g>
</svg>
`;

await fs.mkdir(path.join(root, 'build'), { recursive: true });
await fs.writeFile(path.join(root, 'build/icon.svg'), svg);
console.log('build/icon.svg written');
