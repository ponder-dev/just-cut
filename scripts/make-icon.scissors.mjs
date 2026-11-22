/*
 * Just Cut's icon: a pair of scissors.
 *
 * Round 1 was two pieces of film with a splice between them. It was rejected
 * for the reason that matters: it described the output rather than the act.
 * Somebody looking at a Dock has to know what the tool does to a video, and
 * "cut" has one universally understood object. Film strips are what the file
 * is, scissors are what the tool is. That generator is kept beside this one as
 * make-icon.filmsplice.mjs, and the clapperboard, which belongs to Just Edit,
 * is kept as make-icon.clapperboard.mjs. Nothing builds from either.
 *
 * Scissors also solve the silhouette problem the film strip was chosen for. An
 * X of two blades with two rings under it is the only crossing shape in the
 * family, so it survives a row of otherwise rectangular icons.
 *
 * Everything is drawn fat on purpose. At 16 pixels the whole mark is an X and
 * two dots, so thin blades and realistic ring gaps would close up into a blob.
 * Detail that only works at 1024 is detail that is lying to you.
 *
 * The tile is the house superellipse, exponent 5, drawn at 824 inside 1024, and
 * its path is byte identical to the other tools' because that is the only
 * family check worth trusting.
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

const PIVOT = { x: 512, y: 548 };
const TIP_L = { x: 372, y: 196 };
const TIP_R = { x: 652, y: 196 };
const BLADE = { base: 46, tip: 11, overrun: 44 };   // overrun makes the blades cross
const HANDLE = { r: 76, stroke: 36, drop: 0.62 };   // 0.62 puts the rings just touching
const TILT = -13;                                    // upright scissors look like a logo

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

// One arm runs tip to pivot and straight on into its ring, because that is how
// scissors are actually built: the blade and the handle are one rigid piece.
function arm(tip) {
  const dx = tip.x - PIVOT.x, dy = tip.y - PIVOT.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const bx = PIVOT.x - ux * BLADE.overrun, by = PIVOT.y - uy * BLADE.overrun;
  const p = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
  return {
    blade: `M${p(bx + nx * BLADE.base, by + ny * BLADE.base)}`
         + `L${p(tip.x + nx * BLADE.tip, tip.y + ny * BLADE.tip)}`
         + `L${p(tip.x - nx * BLADE.tip, tip.y - ny * BLADE.tip)}`
         + `L${p(bx - nx * BLADE.base, by - ny * BLADE.base)}Z`,
    // The cutting edge, as a sliver down one side. It is what stops each blade
    // reading as a plain grey wedge at 128.
    edge: `M${p(bx + nx * BLADE.base, by + ny * BLADE.base)}`
        + `L${p(tip.x + nx * BLADE.tip, tip.y + ny * BLADE.tip)}`
        + `L${p(tip.x + nx * (BLADE.tip - 3), tip.y + ny * (BLADE.tip - 3))}`
        + `L${p(bx + nx * (BLADE.base - 22), by + ny * (BLADE.base - 22))}Z`,
    ring: { x: PIVOT.x - dx * HANDLE.drop, y: PIVOT.y - dy * HANDLE.drop },
  };
}

const left = arm(TIP_L);
const right = arm(TIP_R);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${GRADIENT.from}"/>
      <stop offset="1" stop-color="${GRADIENT.to}"/>
    </linearGradient>
    <linearGradient id="steel" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#f4f4f8"/>
      <stop offset="1" stop-color="#c8cdd8"/>
    </linearGradient>
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="12" stdDeviation="15" flood-color="#0b0910" flood-opacity="0.30"/>
    </filter>
  </defs>

  <path d="${squirclePath(CANVAS / 2, CANVAS / 2, ART / 2, N)}" fill="url(#bg)"/>

  <g filter="url(#drop)" transform="rotate(${TILT} ${CANVAS / 2} ${CANVAS / 2})">
    <circle cx="${left.ring.x.toFixed(1)}" cy="${left.ring.y.toFixed(1)}" r="${HANDLE.r}"
            fill="none" stroke="#ffd93d" stroke-width="${HANDLE.stroke}"/>
    <circle cx="${right.ring.x.toFixed(1)}" cy="${right.ring.y.toFixed(1)}" r="${HANDLE.r}"
            fill="none" stroke="#ffd93d" stroke-width="${HANDLE.stroke}"/>

    <path d="${left.blade}" fill="url(#steel)"/>
    <path d="${left.edge}" fill="#ffffff" opacity="0.55"/>
    <path d="${right.blade}" fill="url(#steel)"/>
    <path d="${right.edge}" fill="#ffffff" opacity="0.55"/>

    <circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="30" fill="#3a3a47"/>
    <circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="11" fill="#eff2f7"/>
  </g>
</svg>
`;

fs.writeFileSync(out, svg);
console.log(`build/icon.svg written, tile ${ART} inside ${CANVAS}, exponent ${N}`);
