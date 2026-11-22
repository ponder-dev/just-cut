/*
 * Just Cut's icon: one strip of three frames, severed through the middle frame,
 * with the scissors still on it.
 *
 * Round 4. Round 3 drew two separate pieces that happened to sit near each
 * other, which reads as two objects rather than one thing that was cut, and it
 * put six small sprockets on each so the film looked like a dotted bar. Both
 * are fixed here and the second fix is in the shared part, so Just Color and
 * Just Overlay get it too.
 *
 * The severed middle frame is the whole idea and it needs the lattice pinned to
 * an absolute origin rather than centred per piece. Both halves are laid out on
 * the same 200 grid anchored at ORIGIN, then clipped to their own piece, so the
 * left half of frame 2 and the right half of frame 2 line up across the gap and
 * read as one frame that has been cut. Centring the frames inside each piece
 * would put two independent runs of frames side by side, which is what round 3
 * did.
 *
 * The handles no longer float. Round 3 drew a blade from the pivot and a ring
 * out in space with nothing between them, so the rings read as a separate
 * object hanging above the film. Each arm is now one continuous shank from the
 * ring, through the pivot, out to the blade tip.
 *
 * Judged at 32 and 128. Top light is 0.18, per the sheet.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'build', 'icon.svg');

const CANVAS = 1024;
const ART = 824;          // filling the canvas makes it look oversized in the Dock
const N = 5;              // about what macOS uses; a circular arc reads as wrong
const GRADIENT = { from: '#6d8bff', to: '#8a5cf6' };

function squirclePath(cx, cy, radius, exponent, steps = 720) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const c = Math.cos(t), s = Math.sin(t);
    const x = cx + radius * Math.sign(c) * Math.abs(c) ** (2 / exponent);
    const y = cy + radius * Math.sign(s) * Math.abs(s) ** (2 / exponent);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return 'M' + pts.join('L') + 'Z';
}

// The shared film part. Fixed rendering, free composition. See
// sites/ponderdev/logo/tool-sheet.html.
//
// Revised 2026-08-28: the sprockets were too small and there were too many of
// them, so a strip read as a dotted bar rather than as film. Pitch went from 93
// to 200 and the perforation from 34 to 52, which is one sprocket per frame
// centred on it. On a 620 strip that is three frames and three sprockets a side
// instead of six and six. At 32 pixels a 178 unit frame is 5.6 px and a 52 unit
// sprocket is 1.6 px, where the old 34 unit one was 1.1 and mushed.
const FILM = {
  r: 26, perf: 52, step: 200, inset: 26, hole: 10, sheen: 14,
  gutter: 14,        // between a sprocket row and the frame band
  gap: 22,           // between one frame and the next
  base: '#565a6d',   // ungraded frame grey, shared across the video tools
};

// grid: frames and sprockets can be laid out relative to the strip, or pinned
// to an absolute x so that two pieces of one cut strip stay in register. Just
// Cut needs the second: its middle frame is severed, and half a frame has to
// line up with the other half across the gap.
function lattice(x, y, w, h, origin, vertical) {
  const along = vertical ? h : w;
  const from = vertical ? y : x;
  if (origin === null) {
    const count = Math.floor(along / FILM.step);
    const start = from + (along - count * FILM.step) / 2;
    return Array.from({ length: count }, (_, i) => start + i * FILM.step);
  }
  const first = Math.floor((from - origin) / FILM.step) - 1;
  const cells = [];
  for (let k = first; k <= first + Math.ceil(along / FILM.step) + 2; k++) {
    const at = origin + k * FILM.step;
    if (at + FILM.step > from && at < from + along) cells.push(at);
  }
  return cells;
}

function strip(x, y, w, h, opts = {}) {
  const { vertical = false, edges = 'both', frameFill = FILM.base,
          frameOrigin = null, id = 's' } = opts;
  const cells = lattice(x, y, w, h, frameOrigin, vertical);
  const lane = FILM.inset + FILM.perf + FILM.gutter;
  const clip = `clip${id}`;
  let perfs = '', band = '';

  for (const at of cells) {
    const mid = at + FILM.step / 2;
    const fo = at + FILM.gap / 2, fs = FILM.step - FILM.gap;
    if (vertical) {
      const bx = x + lane;
      const bw = (edges === 'both' ? x + w - lane : x + w - FILM.gutter) - bx;
      perfs += hole(x + FILM.inset, mid - FILM.perf / 2)
             + (edges === 'both' ? hole(x + w - FILM.inset - FILM.perf, mid - FILM.perf / 2) : '');
      if (frameFill) band += frame(bx, fo, bw, fs, frameFill);
    } else {
      const by = y + lane;
      const bh = (edges === 'both' ? y + h - lane : y + h - FILM.gutter) - by;
      perfs += hole(mid - FILM.perf / 2, y + FILM.inset)
             + (edges === 'both' ? hole(mid - FILM.perf / 2, y + h - FILM.inset - FILM.perf) : '');
      if (frameFill) band += frame(fo, by, fs, bh, frameFill);
    }
  }
  // Everything on the lattice is clipped to the strip, so a frame or a sprocket
  // that straddles a cut is severed rather than hanging in the air.
  return `<defs><clipPath id="${clip}">`
       + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${FILM.r}"/></clipPath></defs>`
       + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${FILM.r}" fill="url(#film)"/>`
       + `<g clip-path="url(#${clip})">${band}`
       + `<rect x="${x}" y="${y}" width="${w}" height="${FILM.sheen}" rx="${FILM.sheen / 2}" fill="#ffffff" opacity="0.18"/>`
       + `${perfs}</g>`;
}

function hole(x, y) {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${FILM.perf}" height="${FILM.perf}" `
       + `rx="${FILM.hole}" fill="#eef0f6" opacity="0.95"/>`;
}
function frame(x, y, w, h, fill) {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" `
       + `height="${h.toFixed(1)}" rx="8" fill="${fill}"/>`;
}

// The conceptual full strip, before it was cut, and the grid its frames sit on.
// ORIGIN is chosen so the middle of frame 2 lands on x=512.
const ORIGIN = 212;
const CUT = 512;
const FULL = { x: 202, y: 540, w: 620, h: 300 };
const GAP = 26;
const DROP = 22;          // the right half falls, so the cut already happened

const LEFT  = { x: FULL.x, y: FULL.y, w: CUT - GAP / 2 - FULL.x, h: FULL.h };
const RIGHT = { x: CUT + GAP / 2, y: FULL.y + DROP, w: FULL.x + FULL.w - CUT - GAP / 2, h: FULL.h };

// Pivot sits in the severed frame, because that is where a cut happens.
const PIVOT = { x: CUT, y: 690 };
const TIPS = [{ x: 388, y: 862 }, { x: 636, y: 862 }];
const BLADE = { base: 40, tip: 12 };
const RING = { r: 62, stroke: 30, reach: 1.30 };
const SHANK = 34;

function arm(tip) {
  const dx = tip.x - PIVOT.x, dy = tip.y - PIVOT.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const p = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const ring = { x: PIVOT.x - dx * RING.reach, y: PIVOT.y - dy * RING.reach };
  return {
    ring,
    // One continuous piece: ring, shank, pivot, blade. Nothing floats.
    shank: `<line x1="${ring.x.toFixed(1)}" y1="${ring.y.toFixed(1)}" x2="${PIVOT.x}" y2="${PIVOT.y}"
              stroke="url(#steel)" stroke-width="${SHANK}" stroke-linecap="round"/>`,
    blade: `M${p(PIVOT.x + nx * BLADE.base, PIVOT.y + ny * BLADE.base)}`
         + `L${p(tip.x + nx * BLADE.tip, tip.y + ny * BLADE.tip)}`
         + `L${p(tip.x - nx * BLADE.tip, tip.y - ny * BLADE.tip)}`
         + `L${p(PIVOT.x - nx * BLADE.base, PIVOT.y - ny * BLADE.base)}Z`,
  };
}
const arms = TIPS.map(arm);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${GRADIENT.from}"/><stop offset="1" stop-color="${GRADIENT.to}"/>
    </linearGradient>
    <linearGradient id="film" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b3b47"/><stop offset="1" stop-color="#1b1b23"/>
    </linearGradient>
    <linearGradient id="steel" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#f4f4f8"/><stop offset="1" stop-color="#c8cdd8"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#ffe066"/><stop offset="1" stop-color="#ffd93d"/>
    </linearGradient>
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="12" stdDeviation="15" flood-color="#0b0910" flood-opacity="0.30"/>
    </filter>
    <filter id="lift" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#0b0910" flood-opacity="0.45"/>
    </filter>
  </defs>

  <path d="${squirclePath(CANVAS / 2, CANVAS / 2, ART / 2, N)}" fill="url(#bg)"/>

  <g filter="url(#drop)">
    ${strip(LEFT.x, LEFT.y, LEFT.w, LEFT.h, { frameOrigin: ORIGIN, id: 'L' })}
    ${strip(RIGHT.x, RIGHT.y, RIGHT.w, RIGHT.h, { frameOrigin: ORIGIN, id: 'R' })}
    ${arms.map(a => a.shank).join('')}
    ${arms.map(a => `<circle cx="${a.ring.x.toFixed(1)}" cy="${a.ring.y.toFixed(1)}" r="${RING.r}"
        fill="none" stroke="#ffd93d" stroke-width="${RING.stroke}"/>`).join('')}
    ${arms.map(a => `<path d="${a.blade}" fill="url(#steel)"/>`).join('')}
    <circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="24" fill="#3a3a47"/>
    <circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="8" fill="#eff2f7"/>
  </g>
</svg>
`;

fs.writeFileSync(out, svg);
console.log(`build/icon.svg written, tile ${ART} inside ${CANVAS}, exponent ${N}`);
