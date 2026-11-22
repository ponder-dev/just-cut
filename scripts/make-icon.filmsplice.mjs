/*
 * Just Cut's icon: two pieces of film, cut apart and stepped, with the splice
 * between them.
 *
 * Why this and not the clapperboard: the clapperboard came over from SubSmash
 * and belongs to Just Edit, the suite, rather than to one tool in it. It is
 * kept beside this file as make-icon.clapperboard.mjs.
 *
 * Why two pieces: it is what the tool actually produces. Trim, split and
 * reorder all end with footage in more than one piece and in a chosen order,
 * and the offset is that order made visible. It also gives the one thing the
 * family was short of. Every other icon is a rectangle except Just Color's
 * fan, so a diagonal step reads as itself in a Dock row rather than as another
 * dark box.
 *
 * The tile is the house superellipse, exponent 5, drawn at 824 inside 1024, and
 * its path is byte identical to the other tools' because that is the only
 * family check worth trusting.
 *
 * Perforations are deliberately fat. At 16 pixels a realistic sprocket hole is
 * mush, and detail that only works at 1024 is detail that is lying to you.
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

// The two pieces. Stepped so the lower one sits right and below, which is what
// makes the silhouette diagonal rather than square.
const PIECE = { w: 372, h: 208, r: 20 };
const TOP = { x: 150, y: 348 };
const BOTTOM = { x: 502, y: 500 };
const PERF = { count: 4, size: 34, inset: 26 };
const SPLICE = { w: 104, h: 250, r: 22, angle: 22, cx: 512, cy: 512 };

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

// A row of sprocket holes along one edge of a piece.
function perforations(x, y, w, fromTop) {
  const step = w / PERF.count;
  const cy = fromTop ? y + PERF.inset : y + PIECE.h - PERF.inset - PERF.size;
  let s = '';
  for (let i = 0; i < PERF.count; i++) {
    const px = x + step * i + (step - PERF.size) / 2;
    s += `<rect x="${px.toFixed(1)}" y="${cy.toFixed(1)}" width="${PERF.size}" `
       + `height="${PERF.size}" rx="7" fill="#eef0f6" opacity="0.95"/>`;
  }
  return s;
}

function piece(x, y) {
  return `
    <g>
      <rect x="${x}" y="${y}" width="${PIECE.w}" height="${PIECE.h}" rx="${PIECE.r}" fill="url(#film)"/>
      <rect x="${x}" y="${y}" width="${PIECE.w}" height="14" rx="7" fill="#ffffff" opacity="0.18"/>
      ${perforations(x, y, PIECE.w, true)}
      ${perforations(x, y, PIECE.w, false)}
    </g>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${GRADIENT.from}"/>
      <stop offset="1" stop-color="${GRADIENT.to}"/>
    </linearGradient>
    <linearGradient id="film" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b3b47"/>
      <stop offset="1" stop-color="#1b1b23"/>
    </linearGradient>
    <linearGradient id="tape" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe066"/>
      <stop offset="1" stop-color="#ffc61a"/>
    </linearGradient>
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="12" stdDeviation="15" flood-color="#0b0910" flood-opacity="0.30"/>
    </filter>
  </defs>

  <path d="${squirclePath(CANVAS / 2, CANVAS / 2, ART / 2, N)}" fill="url(#bg)"/>

  <g filter="url(#drop)">
    ${piece(TOP.x, TOP.y)}
    ${piece(BOTTOM.x, BOTTOM.y)}
    <g transform="rotate(${SPLICE.angle} ${SPLICE.cx} ${SPLICE.cy})">
      <rect x="${SPLICE.cx - SPLICE.w / 2}" y="${SPLICE.cy - SPLICE.h / 2}"
            width="${SPLICE.w}" height="${SPLICE.h}" rx="${SPLICE.r}" fill="url(#tape)"/>
      <rect x="${SPLICE.cx - SPLICE.w / 2}" y="${SPLICE.cy - SPLICE.h / 2}"
            width="${SPLICE.w}" height="16" rx="8" fill="#ffffff" opacity="0.32"/>
    </g>
  </g>
</svg>
`;

fs.writeFileSync(out, svg);
console.log(`build/icon.svg written, tile ${ART} inside ${CANVAS}, exponent ${N}`);
