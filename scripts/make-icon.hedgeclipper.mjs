/*
 * Just Cut's icon: scissors halfway through a strip of film. The kerf runs down
 * from the top edge and stops; the bottom of the strip is still joined.
 *
 * Round 6, and the first one that shows the tool working rather than the job
 * finished. Round 5 drew the strip already in two pieces, which is an outcome.
 * A cut that has not got all the way through is an action, and it also solves
 * a composition problem: one continuous strip is one object, where two pieces
 * were always at risk of reading as two.
 *
 * The film is byte for byte Just Overlay's: pitch 340, 520 by 390 at 252, 317.
 * Same stock, same distance, same place on the tile. That is the point of the
 * shared part, and it means the only thing that distinguishes these two icons
 * is what is being done to the film.
 *
 * THE CUT IS A HINGE, NOT A SLOT. Round 6 masked a narrow wedge out of the
 * middle, which is what a laser does, not a pair of scissors. Cutting into a
 * strip lets the two halves spring apart, so the void is a TRIANGLE with its
 * apex at the bottom of the cut, and the whole silhouette gets wider toward the
 * top. Each half is a trapezoid and the outline is a trapezoid.
 *
 * So each half is clipped at the centre line and rotated 4 degrees about the
 * apex at 512, 572, which opens 62 at the top edge. The strip below the apex is
 * drawn unrotated and whole, so the whole bottom perforation lane is unbroken:
 * the cut has gone through the frame and stopped above the sprockets. That band
 * is the bridge. An unfinished cut is an action; two loose pieces are an
 * outcome.
 *
 * The angle is derived rather than chosen. Moving the apex changes how much
 * height sits above it, so holding the opening at 62 means HINGE = asin(62/2h).
 * Anyone moving APEX has to recompute it or the split silently narrows.
 *
 * Getting the geometry right took one wrong attempt worth recording. The first
 * try kept the blades near parallel so they would sit inside the kerf, and bent
 * the handles out wide so they read as two. The result was a wishbone. What it
 * lost is the X: a pair of scissors is read as two lines CROSSING, and if the
 * blades do not cross the handles nothing else about the drawing rescues it.
 *
 * The scissors sit ON the apex, because the apex IS the cut. Everything about
 * their placement follows from that one fact rather than from composition.
 *
 * One blade passes BEHIND the film and one in front. That is the whole trick:
 * scissors work by straddling the material, so a pair drawn entirely on top of
 * something is a sticker of scissors rather than scissors cutting. The draw
 * order is blade, film, blade, grips. It costs nothing and it is the single
 * thing that makes the tool look like it is engaged with the strip.
 *
 * The handles run up to the top right at 40 degrees off vertical, which is how
 * a right hand holds them, and it puts both bulbs clear of the film so the red
 * is never interrupted. Only the blades cross the strip.
 *
 * The X survives because the arms BOW rather than bend. Each shank leaves the
 * pivot heading directly opposite its own blade, so the two arms genuinely
 * cross there, and only then curves out to its bulb. That is how real scissors
 * are made and it is what lets the blades be nearly closed, 40 units apart at
 * the tips, while the handles sit 232 apart. Straight arms through the pivot
 * would tie blade splay to handle splay and force one of them wrong; a bend AT
 * the pivot destroys the crossing and produces a wishbone, which round 6 did.
 *
 * The blades are nearly closed because that is what halfway through looks like.
 * The kerf is finished above their tips and the film below is untouched, which
 * leaves a 53 unit bridge still joined at the bottom. The bridge is the whole
 * idea: an unfinished cut is an action, two loose pieces are an outcome.
 *
 * The kerf is a mask, not a shape drawn over the film. Painting the tile colour
 * on top would break the moment anything sat behind the strip.
 *
 * Colours are all sheet surfaces: steel for the blades, object red for the
 * plastic, frame grey for the frame, slate for the film body.
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

const F = film(340);                        // identical to Just Overlay
const STRIP = { x: 252, y: 317, w: 520, h: 390 };   // centred on 512 both ways
// The apex of the cut. 615 is just inside the bottom perforation lane, which
// starts at 612.6, so the cut has gone through the frame and stopped in the
// sprockets. HINGE is how far each half has sprung open.
const APEX = { x: 512, y: 572 };
// 6.98, not 6. The apex moved up 43 so there is less height above it, and the
// angle is derived to hold the top gap where it was: asin(62 / 2h), h = 255.
const HINGE = 6.98;
const SPLIT = 12;                           // the kerf itself, before springing

// Working the film on its own first. Both switches are here rather than the
// scissors being deleted, so putting them back is one word and the geometry
// they depend on cannot drift while they are off.
const SCISSORS = process.env.CUT_SCISSORS !== '0';
const CUT = process.env.CUT_KERF !== '0';

// The pivot IS the apex of the cut.
const PIVOT = { x: APEX.x, y: APEX.y };
const AXIS = 40;                  // degrees off vertical, handles to the top right
// Scaled right down. At blade 190 with handle 400 the ratio was 2.1 to 1 and
// they read as hedge clippers: household scissors are nearer 1.5, and the
// overall reach is now 65% of what it was so the FILM stays the subject.
const REACH = { blade: 150, handle: 235 };
const SPREAD = { tip: 28, bulb: 118 };   // across the axis
const BLADE = { base: 24, tip: 9 };
const GRIP = { shank: 34, bulb: 44, hole: 22, bow: 0.5 };

const ax = Math.sin((AXIS * Math.PI) / 180), ay = -Math.cos((AXIS * Math.PI) / 180);
const px = -ay, py = ax;                 // across the axis
// Each arm runs from a bulb on one side of the axis to a tip on the OTHER side.
// That opposition is the X, and without it a pair of scissors is a wishbone.
const SIDES = [1, -1];
const TIPS  = SIDES.map(sd => ({ x: PIVOT.x - ax * REACH.blade - px * sd * SPREAD.tip / 2,
                                 y: PIVOT.y - ay * REACH.blade - py * sd * SPREAD.tip / 2 }));
const BULBS = SIDES.map(sd => ({ x: PIVOT.x + ax * REACH.handle + px * sd * SPREAD.bulb / 2,
                                 y: PIVOT.y + ay * REACH.handle + py * sd * SPREAD.bulb / 2 }));

const arms = TIPS.map((tip, i) => {
  const bulb = BULBS[1 - i];   // opposite side: this is the X
  const dx = tip.x - PIVOT.x, dy = tip.y - PIVOT.y, len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len;
  // The shank leaves the pivot heading straight back along its own blade, then
  // bows out to the bulb. That first heading is what preserves the crossing.
  const ctlX = PIVOT.x - dx * GRIP.bow;
  const ctlY = PIVOT.y - dy * GRIP.bow;
  const p = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
  return {
    id: `g${i}`,
    mask: `<mask id="g${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="${CANVAS}" height="${CANVAS}">
        <rect width="${CANVAS}" height="${CANVAS}" fill="#000"/>
        <path d="M${PIVOT.x},${PIVOT.y} Q${ctlX.toFixed(1)},${ctlY.toFixed(1)} ${bulb.x},${bulb.y}"
              fill="none" stroke="#fff" stroke-width="${GRIP.shank}" stroke-linecap="round"/>
        <circle cx="${bulb.x}" cy="${bulb.y}" r="${GRIP.bulb}" fill="#fff"/>
        <circle cx="${bulb.x}" cy="${bulb.y}" r="${GRIP.hole}" fill="#000"/>
      </mask>`,
    blade: `M${p(PIVOT.x + nx * BLADE.base, PIVOT.y + ny * BLADE.base)}`
         + `L${p(tip.x + nx * BLADE.tip, tip.y + ny * BLADE.tip)}`
         + `L${p(tip.x - nx * BLADE.tip, tip.y - ny * BLADE.tip)}`
         + `L${p(PIVOT.x - nx * BLADE.base, PIVOT.y - ny * BLADE.base)}Z`,
  };
});

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
    <linearGradient id="steelBack" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#cfd4e0"/><stop offset="1" stop-color="#a7adbd"/>
    </linearGradient>
    <linearGradient id="plastic" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#f45c62"/><stop offset="1" stop-color="#e0384f"/>
    </linearGradient>
    <linearGradient id="grey" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#6f748c"/><stop offset="1" stop-color="#565a6d"/>
    </linearGradient>
    <clipPath id="below"><rect x="0" y="${APEX.y}" width="${CANVAS}" height="${CANVAS}"/></clipPath>
    <clipPath id="halfL"><rect x="0" y="0" width="${APEX.x - SPLIT / 2}" height="${APEX.y}"/></clipPath>
    <clipPath id="halfR"><rect x="${APEX.x + SPLIT / 2}" y="0" width="${CANVAS}" height="${APEX.y}"/></clipPath>
    ${arms.map(a => a.mask).join('')}
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="12" stdDeviation="15" flood-color="#0b0910" flood-opacity="0.30"/>
    </filter>
  </defs>

  <path d="${squirclePath(CANVAS / 2, CANVAS / 2, ART / 2, N)}" fill="url(#bg)"/>

  <g filter="url(#drop)">
    ${!SCISSORS ? '' : `<path d="${arms[0].blade}" fill="url(#steelBack)"/>`}
    ${!CUT
      ? strip(F, STRIP.x, STRIP.y, STRIP.w, STRIP.h, { mode: 'zoom', frameFill: 'url(#grey)', id: 'c' })
      : `<g clip-path="url(#below)">${strip(F, STRIP.x, STRIP.y, STRIP.w, STRIP.h, { mode: 'zoom', frameFill: 'url(#grey)', id: 'b' })}</g>
         <g transform="rotate(${-HINGE} ${APEX.x} ${APEX.y})"><g clip-path="url(#halfL)">
           ${strip(F, STRIP.x, STRIP.y, STRIP.w, STRIP.h, { mode: 'zoom', frameFill: 'url(#grey)', id: 'l' })}
         </g></g>
         <g transform="rotate(${HINGE} ${APEX.x} ${APEX.y})"><g clip-path="url(#halfR)">
           ${strip(F, STRIP.x, STRIP.y, STRIP.w, STRIP.h, { mode: 'zoom', frameFill: 'url(#grey)', id: 'r' })}
         </g></g>`}
    ${!SCISSORS ? '' : `<path d="${arms[1].blade}" fill="url(#steel)"/>`}
    ${!SCISSORS ? '' : arms.map(a => `<rect width="${CANVAS}" height="${CANVAS}" fill="url(#plastic)" mask="url(#${a.id})"/>`).join('')}
    ${!SCISSORS ? '' : `<circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="21" fill="#3a3a47"/>
    <circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="8" fill="#eff2f7"/>`}
  </g>
</svg>
`;

fs.writeFileSync(out, svg);
console.log(`build/icon.svg written, tile ${ART} inside ${CANVAS}, exponent ${N}`);
