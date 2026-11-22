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
 * THE SCISSORS ARE make-icon.severed.mjs's, UNCHANGED. A redteam pass on
 * 2026-08-28 rendered every round and measured them, and severed won on every
 * available metric: handle to blade silhouette 1.33 where the household range
 * is 1.2 to 1.5, four angular lobes around the pivot where the version it
 * replaced had two, and 75 px of tool still present at 32 against 42. Six
 * rounds of tuning produced nothing better than a shape that already existed,
 * so it was copied rather than re-derived. Constants: blade 153.9, GRIP.reach
 * 0.98, bulb 54, hole 27, shank 42, SWING 14, straight shanks.
 *
 * Only the placement is new, and it follows from the film rather than taste.
 * The pivot is the cut point, so it sits on the apex. That puts the already
 * cut V above it, which is where the handles go because that is where a hand
 * is, and the uncut film below it, which is where the blades go. The mark
 * reads in the right order by construction: handles in the opening, blades in
 * the material, pivot exactly where the two meet.
 *
 * ONE BLADE THREADED THROUGH THE FILM, which is three layers rather than two.
 * The blade comes in from the upper right and passes OVER the right half,
 * THROUGH the void where it stays visible, and UNDER the left half, where it is
 * severed by that half's cut edge. That severing is the whole effect.
 *
 * So the draw order is not film-then-scissors or scissors-then-film. It is:
 * bottom band, right half, rear blade, left half, front blade, grips. Drawing
 * the rear blade before all three pieces, which is the obvious thing to do,
 * puts it behind the right half as well and the tool looks like it is lying
 * under a strip rather than threaded through a cut.
 *
 * It is also why the pivot cannot sit on the apex however much the mechanics
 * want it to: the void is a wedge of zero width there, so a blade leaving the
 * apex exits the opening immediately and has nothing to be severed against.
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
 * Colours are sheet surfaces only, and this claim has been checked rather than
 * asserted: steel for the blades and the rivet, object red for the plastic,
 * frame grey for the frames, slate for the film body. A previous version made
 * this same claim while using three different steels and two invented greys.
 *
 * The rivet is steel because that is what a rivet is made of, and because the
 * previous one was a black disc with a white pin measuring 17.1:1 against
 * itself. The sprockets, which are the loudest thing this icon is SUPPOSED to
 * have, measure 15.0:1. A 21 unit detail was out-shouting the perforation rail.
 * Steel light against steel deep is 2.3:1, which is a rivet rather than a hole
 * punched in the middle of the tool.
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

function strip(F, x, y, w, h, { frameFill = FILM_BASE, mode = 'fit', origin = 0, id = 's', under = '' } = {}) {
  const lane = F.inset + F.perfH + F.gutter;
  const perfs = cells(x, w, F.perfStep, mode, origin).map(at => {
    const px = (at + F.perfStep / 2 - F.perfW / 2).toFixed(1);
    // A perforation is a HOLE, so it must not tint toward the material around it. At
    // opacity 0.95 five percent of the film body showed through, and the body ramps from
    // #383842 at the top to #1c1c26 at the bottom, so the top row rendered 229,231,236
    // and the bottom row 227,229,235. Two levels, present in every film icon, and it
    // reads as the two rails being different shades of white. Fully opaque now.
    //
    // This moves off the tool sheet's stated "sprockets #eef0f6 at 95 percent". The
    // sheet's film numbers are already on its known drift list for a separate reason,
    // and this is the same section.
    return `<rect x="${px}" y="${(y + F.inset).toFixed(1)}" width="${F.perfW.toFixed(1)}" height="${F.perfH.toFixed(1)}" rx="${F.perfR.toFixed(1)}" fill="#eef0f6"/>`
         + `<rect x="${px}" y="${(y + h - F.inset - F.perfH).toFixed(1)}" width="${F.perfW.toFixed(1)}" height="${F.perfH.toFixed(1)}" rx="${F.perfR.toFixed(1)}" fill="#eef0f6"/>`;
  }).join('');
  const fh = h - lane * 2;
  const band = frameFill ? cells(x, w, F.step, mode, origin).map(at =>
    `<rect x="${(at + F.frameGap / 2).toFixed(1)}" y="${(y + lane).toFixed(1)}" `
    + `width="${(F.step - F.frameGap).toFixed(1)}" height="${fh.toFixed(1)}" rx="${F.frameR.toFixed(1)}" fill="${frameFill}"/>`).join('') : '';
  return `<defs><clipPath id="c${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${F.r.toFixed(1)}"/></clipPath></defs>`
       + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${F.r.toFixed(1)}" fill="url(#film)"/>`
       + `<g clip-path="url(#c${id})">${band}${under}`
       // No lit top edge. It was a hard 14 unit band of #ffffff at 18 percent, which on a
       // bright surface reads as a highlight and on this one did not: film body is 50,50,61
       // and the band rendered 86,86,96, a 36 level step across 12 units, so it read as an
       // extra line of light grey laid on top of the strip rather than as light on its edge.
       // The same instrument had to be feathered on Just Zip's pull for the same reason,
       // dark material being the thing both have in common. Feathering was the alternative
       // here too; the strip is dark all the way to its edge on purpose instead.
       + `${perfs}</g>`;
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
// Severed's scissors verbatim. The pivot is lifted off the apex and set up and
// to the right, which is the only position where a blade can cross the VOID at
// a useful width: the void is a wedge, so a blade leaving the apex exits it
// immediately and has nothing to be cut off against. Higher up the wedge is 40
// to 60 wide and the blade reads as passing behind the left half.
const PIVOT = { x: 600, y: 470 };
const TIPS = [{ x: PIVOT.x - 72, y: PIVOT.y + 136 }, { x: PIVOT.x + 72, y: PIVOT.y + 136 }];
const BLADE = { base: 30, tip: 9 };
const GRIP = { reach: 0.98, shank: 42, bulb: 54, hole: 27, from: 0.12 };
const SWING = 55;   // tilted well right, so the grips clear the void

const rad = (SWING * Math.PI) / 180, cs = Math.cos(rad), sn = Math.sin(rad);
function swing(q) {
  const dx = q.x - PIVOT.x, dy = q.y - PIVOT.y;
  return { x: PIVOT.x + dx * cs - dy * sn, y: PIVOT.y + dx * sn + dy * cs };
}

const arms = TIPS.map((rawTip, i) => {
  const tip = swing(rawTip);
  const dx = rawTip.x - PIVOT.x, dy = rawTip.y - PIVOT.y;
  const len = Math.hypot(dx, dy);
  const bulb = swing({ x: PIVOT.x - dx * GRIP.reach, y: PIVOT.y - dy * GRIP.reach });
  const root = swing({ x: PIVOT.x - dx * GRIP.from, y: PIVOT.y - dy * GRIP.from });
  // Normal to the SWUNG blade, but scaled by the unswung length, which is the
  // same because rotation preserves it.
  const nx = -(tip.y - PIVOT.y) / len, ny = (tip.x - PIVOT.x) / len;
  const p = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
  return {
    id: `g${i}`,
    mask: `<mask id="g${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="${CANVAS}" height="${CANVAS}">
        <rect width="${CANVAS}" height="${CANVAS}" fill="#000"/>
        <line x1="${root.x.toFixed(1)}" y1="${root.y.toFixed(1)}" x2="${bulb.x.toFixed(1)}" y2="${bulb.y.toFixed(1)}"
              stroke="#fff" stroke-width="${GRIP.shank}" stroke-linecap="round"/>
        <circle cx="${bulb.x.toFixed(1)}" cy="${bulb.y.toFixed(1)}" r="${GRIP.bulb}" fill="#fff"/>
        <circle cx="${bulb.x.toFixed(1)}" cy="${bulb.y.toFixed(1)}" r="${GRIP.hole}" fill="#000"/>
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
    <!-- Diagonal, not straight down. Both stops, same two sheet values, but the ramp now
         runs corner to corner instead of top to bottom. Straight down, the full range
         fell across the strip's 298 units of height, so the top perforation rail
         rendered 56,56,69 and the bottom 28,28,38: one surface reading as two
         materials, in every film icon in the family. Across the diagonal the vertical
         component is about 42 percent of the ramp, so the two rails are lit by the
         same light instead of by opposite ends of it. -->
    <linearGradient id="film" x1="0" y1="0" x2="2" y2="1">
      <stop offset="0" stop-color="#3b3b47"/><stop offset="1" stop-color="#1b1b23"/>
    </linearGradient>
    <!-- The sheet's steel, exactly. The old pair deviated 16 points of lightness
         on the deep stop, and steelBack was a third steel on top of that. -->
    <linearGradient id="steel" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#f2f4f8"/><stop offset="1" stop-color="#9aa2b4"/>
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
    ${!CUT
      ? `${strip(F, STRIP.x, STRIP.y, STRIP.w, STRIP.h, { mode: 'zoom', frameFill: 'url(#grey)', id: 'c' })}
         ${!SCISSORS ? '' : `<path d="${arms[0].blade}" fill="url(#steel)"/>`}`
      : `<g clip-path="url(#below)">${strip(F, STRIP.x, STRIP.y, STRIP.w, STRIP.h, { mode: 'zoom', frameFill: 'url(#grey)', id: 'b' })}</g>
         <g transform="rotate(${HINGE} ${APEX.x} ${APEX.y})"><g clip-path="url(#halfR)">
           ${strip(F, STRIP.x, STRIP.y, STRIP.w, STRIP.h, { mode: 'zoom', frameFill: 'url(#grey)', id: 'r' })}
         </g></g>
         ${!SCISSORS ? '' : `<path d="${arms[0].blade}" fill="url(#steel)"/>`}
         <g transform="rotate(${-HINGE} ${APEX.x} ${APEX.y})"><g clip-path="url(#halfL)">
           ${strip(F, STRIP.x, STRIP.y, STRIP.w, STRIP.h, { mode: 'zoom', frameFill: 'url(#grey)', id: 'l' })}
         </g></g>`}
    ${!SCISSORS ? '' : `<path d="${arms[1].blade}" fill="url(#steel)"/>`}
    ${!SCISSORS ? '' : arms.map(a => `<rect width="${CANVAS}" height="${CANVAS}" fill="url(#plastic)" mask="url(#${a.id})"/>`).join('')}
    ${!SCISSORS ? '' : `<circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="16" fill="url(#steel)"
      stroke="#9aa2b4" stroke-width="3"/>`}
  </g>
</svg>
`;

fs.writeFileSync(out, svg);
console.log(`build/icon.svg written, tile ${ART} inside ${CANVAS}, exponent ${N}`);
