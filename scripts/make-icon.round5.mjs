/*
 * Just Cut's icon: one strip of three frames, severed through the middle one,
 * with the scissors still on it.
 *
 * The severed frame is the whole idea, and it only works because the lattice
 * can be pinned to an absolute origin. Both halves are laid out from ORIGIN on
 * the same 180 grid and then clipped to their own piece, so the left half of
 * the middle frame and the right half line up across the gap and read as one
 * frame that has been cut. Letting each piece centre its own frames, which is
 * what the default does, produces two independent runs of film that happen to
 * sit near each other. That was round 3 and it is why it read as two objects.
 *
 * Pitch 180, the same as Just Color, because this needs three frames to show a
 * middle one. Just Overlay stands at 340 and sees one frame close up. Same
 * stock, different distance; the shared part is proportions, not sizes.
 *
 * The handles do not float. Round 3 drew a blade out of the pivot and a ring
 * sitting in space with nothing between them. Each arm is now one continuous
 * piece: ring, shank, pivot, blade.
 *
 * The scissors are swung 14 degrees. At 0 the two rings sit level and matched
 * above the blades, and a symmetrical pair of circles near the top of a tile
 * reads as eyes or spectacles no matter what is underneath. That cost a whole
 * round to diagnose because it looks like a size problem and is not.
 *
 * Centring: unlike Just Overlay, this is one scene rather than a subject with a
 * satellite, so the whole thing is centred rather than the film alone. Measured
 * bbox is 540 x 502 centred on 512, 515.
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

// The shared film part. Settled on Just Color 2026-08-28.
//
// Everything is a RATIO of the frame pitch, not a fixed size. That is the
// difference between the part being shared and the part being one drawing: a
// tool picks how close it stands to the film, and the proportions come out the
// same. Just Color reads a stack from a distance at pitch 180; Just Overlay
// stands close at pitch 340. Both are the same stock.
//
// The fractions are exact at 180, which is where they were tuned, so Just Color
// renders identically before and after this was made proportional.
const FILM_R = {
  frameGap: 1 / 20, frameR: 1 / 45,
  perfStep: 1 / 3, perfW: 1 / 6, perfH: 7 / 45, perfR: 7 / 180,
  inset: 1 / 15,     // strip edge to perforation. Hard against it, like real stock.
  gutter: 1 / 18,    // perforation to frame band
  r: 1 / 9,          // strip corner
};
const FILM_BASE = '#565a6d';   // ungraded frame grey, shared across the video tools

function film(step) {
  const f = { step, base: FILM_BASE };
  for (const k in FILM_R) f[k] = FILM_R[k] * step;
  return f;
}

// fit:  whole cells centred inside the strip, nothing cut. A strip seen whole.
// zoom: one cell centred and the rest running off both ends, clipped by the
//       strip. A strip seen close, which is the only way to get one full frame
//       with partials either side.
// pin:  cells tiled from an absolute origin regardless of where the strip
//       starts. Just Cut needs this: its film is one strip severed in two, and
//       the halves only read as one cut frame if both are laid out on the same
//       grid rather than each centring its own.
function cells(from, along, pitch, mode, origin) {
  if (mode === 'pin') {
    const first = Math.floor((from - origin) / pitch) - 1;
    const n = Math.ceil(along / pitch) + 3;
    return Array.from({ length: n }, (_, i) => origin + (first + i) * pitch)
      .filter(at => at + pitch > from && at < from + along);
  }
  if (mode === 'fit') {
    const n = Math.floor(along / pitch);
    const start = from + (along - n * pitch) / 2;
    return Array.from({ length: n }, (_, i) => start + i * pitch);
  }
  const mid = from + along / 2;
  const n = Math.ceil(along / pitch) + 2;
  const start = mid - pitch / 2 - Math.ceil(n / 2) * pitch;
  return Array.from({ length: n * 2 + 1 }, (_, i) => start + i * pitch)
    .filter(at => at + pitch > from && at < from + along);
}

function strip(F, x, y, w, h, { frameFill = FILM_BASE, mode = 'fit', origin = 0, id = 's' } = {}) {
  const lane = F.inset + F.perfH + F.gutter;
  const perfs = cells(x, w, F.perfStep, mode, origin).map(at => {
    const px = (at + F.perfStep / 2 - F.perfW / 2).toFixed(1);
    return `<rect x="${px}" y="${(y + F.inset).toFixed(1)}" width="${F.perfW.toFixed(1)}" height="${F.perfH.toFixed(1)}" rx="${F.perfR.toFixed(1)}" fill="#eef0f6" opacity="0.95"/>`
         + `<rect x="${px}" y="${(y + h - F.inset - F.perfH).toFixed(1)}" width="${F.perfW.toFixed(1)}" height="${F.perfH.toFixed(1)}" rx="${F.perfR.toFixed(1)}" fill="#eef0f6" opacity="0.95"/>`;
  }).join('');
  const fh = h - lane * 2;
  const band = frameFill ? cells(x, w, F.step, mode, origin).map(at =>
    `<rect x="${(at + F.frameGap / 2).toFixed(1)}" y="${(y + lane).toFixed(1)}" `
    + `width="${(F.step - F.frameGap).toFixed(1)}" height="${fh.toFixed(1)}" rx="${F.frameR.toFixed(1)}" fill="${frameFill}"/>`).join('') : '';
  return `<defs><clipPath id="c${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${F.r.toFixed(1)}"/></clipPath></defs>`
       + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${F.r.toFixed(1)}" fill="url(#film)"/>`
       + `<g clip-path="url(#c${id})">${band}`
       + `<rect x="${x}" y="${y}" width="${w}" height="14" rx="7" fill="#ffffff" opacity="0.18"/>${perfs}</g>`;
}

const F = film(180);                 // three frames, same distance as Just Color

// The strip as it was before the cut, and the grid its frames sit on. 540 is
// exactly three frames, so the middle one is centred on the tile and the cut
// halves it.
const ORIGIN = 242, FULL_W = 540, CUT = 512, GAP = 26, DROP = 24;
const TOP = 539, H = 200;

const LEFT  = { x: ORIGIN, y: TOP, w: CUT - GAP / 2 - ORIGIN, h: H };
const RIGHT = { x: CUT + GAP / 2, y: TOP + DROP, w: ORIGIN + FULL_W - CUT - GAP / 2, h: H };

const PIVOT = { x: CUT, y: 569 };
const TIPS = [{ x: 420, y: 749 }, { x: 604, y: 749 }];
const BLADE = { base: 38, tip: 11 };
const RING = { r: 64, stroke: 28, reach: 1.15 };
const SHANK = 30;
const SWING = 14;

function arm(tip) {
  const dx = tip.x - PIVOT.x, dy = tip.y - PIVOT.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len;
  const p = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
  return {
    ring: { x: PIVOT.x - dx * RING.reach, y: PIVOT.y - dy * RING.reach },
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
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="12" stdDeviation="15" flood-color="#0b0910" flood-opacity="0.30"/>
    </filter>
  </defs>

  <path d="${squirclePath(CANVAS / 2, CANVAS / 2, ART / 2, N)}" fill="url(#bg)"/>

  <g filter="url(#drop)">
    ${strip(F, LEFT.x, LEFT.y, LEFT.w, LEFT.h, { mode: 'pin', origin: ORIGIN, id: 'L' })}
    ${strip(F, RIGHT.x, RIGHT.y, RIGHT.w, RIGHT.h, { mode: 'pin', origin: ORIGIN, id: 'R' })}

    <g transform="rotate(${SWING} ${PIVOT.x} ${PIVOT.y})">
      ${arms.map(a => `<line x1="${a.ring.x.toFixed(1)}" y1="${a.ring.y.toFixed(1)}" x2="${PIVOT.x}" y2="${PIVOT.y}"
          stroke="url(#steel)" stroke-width="${SHANK}" stroke-linecap="round"/>`).join('')}
      ${arms.map(a => `<circle cx="${a.ring.x.toFixed(1)}" cy="${a.ring.y.toFixed(1)}" r="${RING.r}"
          fill="none" stroke="#ffd93d" stroke-width="${RING.stroke}"/>`).join('')}
      ${arms.map(a => `<path d="${a.blade}" fill="url(#steel)"/>`).join('')}
      <circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="22" fill="#3a3a47"/>
      <circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="8" fill="#eff2f7"/>
    </g>
  </g>
</svg>
`;

fs.writeFileSync(out, svg);
console.log(`build/icon.svg written, tile ${ART} inside ${CANVAS}, exponent ${N}`);
