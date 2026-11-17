/* Wrapped so this file has a scope of its own. plan.js is loaded as a
   classic script, which puts its own top level helpers on the window, and
   two files sharing one scope is how a redeclared name kills a whole page. */
(function () {
'use strict';

'use strict';

/* The window for Just Cut.

   It shows things and it collects clicks. It decides almost nothing: every
   piece of timeline arithmetic comes from plan.js, which is loaded before this
   file. The app this replaces kept a second copy of that maths in the renderer,
   and the two copies did not always agree, so there is deliberately none of it
   here.

   Nothing in this file reaches the network, the filesystem or ffmpeg. All of
   that goes through the preload bridge on window.justcut. */

/* ================================================= the bridge to plan.js === */

// plan.js guards its module.exports so the same file works as a plain script.
// Which global it lands on is its own business, so accept the obvious names
// rather than betting on one of them.
const plan = window.plan || window.justcutPlan || window.JustCutPlan || null;
if (!plan) {
  throw new Error('plan.js did not load, so there is no timeline arithmetic to work with.');
}

const bridge = window.justcut;

/* One wrapper per plan function, so if a signature ever moves there is exactly
   one line to change rather than thirty call sites. targetSize and cropRect are
   handed the first clip as a second argument: that is where the source size
   lives, and a function that only wants the project will ignore it. */
const starts = () => plan.clipStarts(project.clips);
const total = () => plan.totalDuration(project.clips);
const lengthOf = (clip) => plan.clipDuration(clip);

/* plan answers locateClip in source time and returns null past the end. The
   timeline thinks in output time and its callers assume an answer, so both
   translations happen here rather than at each call site. */
const locate = (t) => {
  const list = project.clips;
  if (!list.length) return { i: 0, rel: 0, sourceTime: 0 };
  const hit = plan.locateClip(list, t) || plan.locateClip(list, plan.totalDuration(list));
  const i = hit ? hit.index : list.length - 1;
  const c = list[i] || {};
  const speed = c.speed > 0 ? c.speed : 1;
  const source = hit ? hit.sourceTime : num(c.out, 0);
  return { i, rel: (source - num(c.in, 0)) / speed, sourceTime: source };
};

/* plan.fadeDur describes the join INTO a clip. The timeline numbers its joins
   by the block on the left, so join j is the transition into clip j + 1. */
const overlapAt = (j) => plan.fadeDur(project.clips[j + 1], project.clips[j]);

const outSize = () => {
  const c = project.clips[0] || {};
  return plan.targetSize(project.format, c.w, c.h);
};
const outCrop = () => {
  const c = project.clips[0] || {};
  const size = plan.targetSize(project.format, c.w, c.h);
  return plan.cropRect(c.w, c.h, size.width, size.height, project.pan);
};

// validate may reasonably answer with a list of problems or with an ok flag.
// Both are useful to a person; flatten them to a list of sentences to show.
function problemsWith(p) {
  // plan checks the project against what was actually measured, so hand it the
  // measurements back in the shape it expects rather than a second guess.
  const measurements = {
    clips: p.clips.map((c) => ({
      width: c.w, height: c.h, duration: c.duration, fps: c.fps, hasAudio: c.hasAudio,
    })),
  };
  const r = plan.validate(p, measurements);
  const list = Array.isArray(r) ? r : (r && Array.isArray(r.problems) ? r.problems : []);
  // Warnings are worth knowing and are not worth blocking an export over.
  return list
    .filter((x) => x && x.level !== 'warning')
    .map((x) => (typeof x === 'string' ? x : x.message));
}

/* ====================================================== what is on screen === */

/* The whole document, and the only thing handed to the exporter. Kept plain so
   it can be logged, compared or serialised without any surprises in it. */
const project = {
  // Each clip carries how it joins the one before it, which is the shape plan
  // and the engine both read. clips[0].transition is always 'cut'.
  clips: [],        // { path, name, in, out, speed, transition, duration, w, h, fps, hasAudio }
  format: 'source', // source | vertical | square | wide
  pan: { x: 0.5, y: 0.5 },
  // There is nothing here about how the sound is treated, on purpose. This app
  // cuts audio because it cannot cut a video without cutting the sound, and it
  // stops there. Loudness and one-sided recordings are Just Sound's.
};

const JOINS = ['cut', 'fade', 'slide'];
const JOIN_LABEL = { cut: 'Cut', fade: 'Fade', slide: 'Slide' };
const MIN_CLIP = 0.15;   // seconds of source, so a block can never reach zero

let selected = -1;       // which clip the side panel is describing
let playhead = 0;        // seconds into the finished video
let playing = false;
let busy = false;        // an export is running
let showing = -1;        // which clip the <video> element currently holds
let pending = null;      // a seek waiting for the video to finish loading
let scrubbing = false;
let dragFrom = -1;       // which block is being carried, or -1
let panAxis = null;      // 'x', 'y', or null when the shape crops nothing
let raf = 0;
let zoomNow = 34;        // pixels per second; a float, so a slow pinch still moves it
let carry = null;        // a block being carried by the pointer
let laneDrag = null;     // the scrub strip being dragged
let active = null;       // whichever drag is running, told when the strip scrolls
let swallowClick = false; // the click that ends a carry is not a select

/* The tray (walk, 2026-11-16): files added to an open project wait here,
   and a block can be set aside here and brought back, trim and speed intact.
   It is not part of the project the exporter is handed, so nothing in it can
   reach the finished video. Undo covers it like the timeline. */
const tray = [];          // clips, the same shape as project.clips
const trayPending = [];   // { id, name } while a file is being measured
let pendingId = 0;

/* ========================================================= small helpers === */

const el = (id) => document.getElementById(id);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (n, fallback) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

/* The single place this file touches an element's style, and only ever to set
   a custom property. A zoom level, a playhead position and a progress width are
   genuinely dynamic numbers, and a variable is the only way CSS can receive
   one. Everything static belongs in the stylesheet, and is there. */
function cssVar(node, name, value) { node.style.setProperty(name, value); }

function baseName(p) { return String(p).split(/[\\/]/).pop(); }
function stem(name) { return name.replace(/\.[^.]+$/, ''); }

// 0:03.4, which is the precision a trim is worth reading at.
function clock(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
}
// m:ss, for naming a piece of a file. A tenth of a second is noise there.
function mmss(sec) {
  const s = Math.round(Math.max(0, sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function secs(n) { return (Math.round(n * 10) / 10).toFixed(1) + 's'; }
function rate(s) { return String(Math.round(s * 100) / 100) + 'x'; }

function show(id, text) {
  const node = el(id);
  if (text !== undefined) node.textContent = text;
  node.hidden = false;
}
function hide(id) { el(id).hidden = true; }
// At a small window the progress bar, the result and an error all sit below
// the fold, and nothing else on screen changes, so it looks as if nothing
// happened. Bring the one the user is waiting for into view.
function bringIntoView(id) { el(id).scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

// ipcRenderer.invoke wraps a handler's error as "Error invoking remote
// method 'x': Error: <message>"; only the message is ours to show.
function plainError(err) {
  const text = String((err && err.message) || err || '');
  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}

function clipNodeAt(i) { return el('track').querySelector('.clip[data-i="' + i + '"]'); }

// Transitions belong to the joins between blocks, so there is always one fewer
// of them than there are clips. Anything that adds or removes a clip calls this
// rather than trying to keep the two arrays in step by hand.
function fixJoins() {
  project.clips.forEach((c, i) => {
    // Nothing precedes the first block, so it can only ever be a cut.
    if (i === 0 || !plan.TRANSITIONS[c.transition]) c.transition = 'cut';
  });
}

/* ================================================= loading and unloading === */

// The measurements come back through the bridge from ffprobe. Read the two
// spellings that are natural for each field rather than betting on one, since
// the probe lives in another module.
function measured(m) {
  return {
    duration: num(m.duration !== undefined ? m.duration : m.durationSec, 0),
    w: num(m.width !== undefined ? m.width : m.w, 0),
    h: num(m.height !== undefined ? m.height : m.h, 0),
    fps: num(m.fps, 30),
    hasAudio: m.hasAudio !== false,
  };
}

// Every file added goes to the tray first, from the start screen too
// (decided 2026-11-16: "I don't want them all in the timeline I want them in the
// tray"). You drag one in, cut it, park what you keep, and build the
// final order from the tray. Each file shows a spinner while it is measured.
async function addFiles(paths) {
  if (busy || !paths || !paths.length) return;
  hide('start-error');
  hide('error');
  // One file goes straight onto the end of the timeline; two or more wait in
  // the tray (decided 2026-11-16: "if I upload 1 file it should go on the
  // timeline"). In the editor a tile with a spinner shows while either is read.
  const toTimeline = paths.length === 1;
  const waiting = toTimeline && el('editor').hidden
    ? [] : paths.map((p) => ({ id: ++pendingId, name: baseName(p) }));
  if (waiting.length) {
    trayPending.push(...waiting);
    showEditor(true);
    drawTray();
    drawTimeline();
  }
  const settle = () => {
    for (const w of waiting) {
      const k = trayPending.indexOf(w);
      if (k >= 0) trayPending.splice(k, 1);
    }
  };

  let answer;
  try {
    answer = await bridge.probe(paths);
  } catch (e) {
    settle();
    drawTray();
    if (!project.clips.length && !tray.length) showEditor(false);
    return complain('Those could not be read. ' + plainError(e));
  }
  settle();
  // main answers { clips }, the same shape engine.probe returns, one entry per path.
  const list = Array.isArray(answer) ? answer : (answer && answer.clips) || [];

  const refused = [];
  list.forEach((m, k) => {
    const path = m.path || paths[k];
    const info = measured(m);
    if (m.ok === false || !(info.duration > 0)) { refused.push(baseName(path)); return; }
    (toTimeline ? project.clips : tray).push({
      src: path,
      name: baseName(path),
      in: 0,
      out: info.duration,
      speed: 1,
      transition: 'cut',
      duration: info.duration,
      w: info.w,
      h: info.h,
      fps: info.fps,
      hasAudio: info.hasAudio,
    });
  });

  if (!project.clips.length && !tray.length) {
    drawTray();
    showEditor(false);
    return complain(refused.length
      ? 'No video found in ' + refused.join(', ') + '.'
      : 'Nothing in that could be read as video.');
  }

  showEditor(true);
  if (toTimeline && list.length && !refused.length) selected = project.clips.length - 1;
  afterChange();
  if (refused.length) complain('Left out, no video found: ' + refused.join(', '));
}

function complain(message) {
  const id = el('editor').hidden ? 'start-error' : 'error';
  show(id, message);
  bringIntoView(id);
}

function showEditor(on) {
  el('start').hidden = on;
  el('editor').hidden = !on;
}

// keepHistory: the timeline emptied by an edit (the last clip removed, or an
// undo back to an empty timeline), which undo can still bring back. The
// Start again button clears the history with everything else.
function startAgain(keepHistory) {
  if (busy) return;
  if (keepHistory !== true) forget();
  pause();
  project.clips.length = 0;
  tray.length = 0;
  trayPending.length = 0;
  drawTray();
  selected = -1;
  playhead = 0;
  showing = -1;
  pending = null;
  el('video').removeAttribute('src');
  el('video').load();
  hide('error');
  hide('done');
  hide('start-error');
  showEditor(false);
}

/* ============================================================ the preview === */

/* A plain sequential preview: whichever clip the playhead is in gets played at
   its own speed, between its own in and out points. Transitions are a thing the
   exporter does, and the copy under the timeline says so, because pretending
   otherwise would be a second renderer to keep honest. */

// Which file is in the <video>, as well as which block: a move or an undo can
// put a different clip at the same place in the list.
let showingSrc = null;

function loadInto(i) {
  const src = project.clips[i].src;
  if (i === showing && src === showingSrc) return false;
  showing = i;
  showingSrc = src;
  el('video').src = bridge.fileUrl(src);
  return true;
}

function seek(t) {
  const dur = total();
  playhead = clamp(t, 0, dur);
  if (!project.clips.length) return paint();

  const at = locate(playhead);
  const c = project.clips[at.i];
  const want = clamp(c.in + at.rel * c.speed, c.in, c.out);
  const v = el('video');

  if (loadInto(at.i)) {
    pending = { time: want, rate: c.speed, play: playing };
  } else {
    v.playbackRate = c.speed;
    if (Math.abs(v.currentTime - want) > 0.08) v.currentTime = want;
  }
  paint();
}

function play() {
  if (!project.clips.length || busy) return;
  if (playhead >= total() - 0.05) seek(0);
  playing = true;
  el('play').textContent = 'Pause';
  refreshCutHere();
  el('video').play().catch(() => {});
  if (!raf) raf = requestAnimationFrame(tick);
}

function pause() {
  playing = false;
  el('play').textContent = 'Play';
  el('video').pause();
  refreshCutHere();
}

function tick() {
  raf = 0;
  if (!playing) return;
  const v = el('video');
  const c = project.clips[showing];
  if (c) {
    if (v.currentTime >= c.out - 0.03) {
      if (showing + 1 < project.clips.length) {
        seek(starts()[showing + 1] + 0.001);
        el('video').play().catch(() => {});
      } else {
        pause();
        playhead = total();
        paint();
        return;
      }
    } else {
      playhead = starts()[showing] + (v.currentTime - c.in) / c.speed;
      paint();
    }
    followPlayhead();
  }
  raf = requestAnimationFrame(tick);
}

// Where a moment sits in pixels. Read from the blocks themselves rather than
// recomputed, because a very short clip is held at a minimum width so it
// stays grabbable, and only the block knows that it was.
function pxAt(t) {
  if (!project.clips.length) return 0;
  const at = locate(t);
  const node = clipNodeAt(at.i);
  if (!node) return 0;
  const len = Math.max(0.01, lengthOf(project.clips[at.i]));
  return node.offsetLeft + clamp(at.rel / len, 0, 1) * node.offsetWidth;
}
function playheadPx() { return pxAt(playhead); }

// The other way round: which moment is under a pixel of the timeline. Over a
// join, or past either end, the nearest block edge wins.
function timeAtX(x) {
  const nodes = [...el('track').querySelectorAll('.clip')];
  const begins = starts();
  let best = Infinity;
  let t = 0;
  for (const n of nodes) {
    const i = Number(n.dataset.i);
    const len = lengthOf(project.clips[i]);
    const left = n.offsetLeft;
    const right = left + n.offsetWidth;
    if (x >= left && x <= right) return begins[i] + ((x - left) / n.offsetWidth) * len;
    if (Math.abs(x - left) < best) { best = Math.abs(x - left); t = begins[i]; }
    if (Math.abs(x - right) < best) { best = Math.abs(x - right); t = begins[i] + len; }
  }
  return t;
}

function paint() {
  const dur = total();
  el('time').textContent = clock(playhead) + ' / ' + clock(dur);
  if (!scrubbing) el('scrub').value = String(dur > 0 ? Math.round((playhead / dur) * 2000) : 0);
  // On the strip, not the line, so the Split button beside it can read it too.
  cssVar(el('tl'), '--ph', playheadPx() + 'px');
  refreshCutHere();
}

// Split waits beside the handle wherever the playhead stops, if there is room
// on both sides of it to split.
function refreshCutHere() {
  const button = el('cut-here');
  let fits = false;
  if (project.clips.length && !playing && !busy && !laneDrag && !carry) {
    const at = locate(playhead);
    const c = project.clips[at.i];
    fits = at.sourceTime > c.in + MIN_CLIP && at.sourceTime < c.out - MIN_CLIP;
  }
  button.hidden = !fits;
  if (fits) button.classList.toggle('flip', playheadPx() > el('tl').offsetWidth - 80);
}

// While it plays, or while the slider above is dragged, keep the playhead on
// screen: once it nears an edge the strip jumps so it sits a quarter in.
function followPlayhead() {
  if (carry || laneDrag || !project.clips.length) return;
  const box = el('tl-scroll').getBoundingClientRect();
  const x = el('tl').getBoundingClientRect().left + playheadPx();
  if (x < box.left + 40 || x > box.right - 40) {
    el('tl-scroll').scrollLeft += x - (box.left + box.width * 0.25);
  }
}

/* =========================================================== the timeline === */

/* Pieces. After a split both halves come from one file, and showing only the
   file's name on each made "Remove tester.mp4?" read as removing the whole
   file (walk, 2026-11-16). So a clip that is not the whole file is named
   by its file and its range in that file: "tester.mp4, 0:08 to 0:19". A piece
   of a piece is just a narrower range, so the names never nest, and moving a
   block never renumbers anything. A whole, untrimmed file keeps its name. */
function isWhole(c) {
  return c.in <= 0.05 && c.out >= c.duration - 0.05;
}

function rangeOf(c) {
  // A piece under a second would read "0:08 to 0:08"; tenths keep it honest.
  const a = mmss(c.in);
  const b = mmss(c.out);
  return a === b ? clock(c.in) + ' to ' + clock(c.out) : a + ' to ' + b;
}

function blockTitle(c) {
  return labelOf(c) + '. Drag to move it, or onto the tray to set it aside. Double-click to jump to it.';
}

function labelOf(c) {
  return isWhole(c) ? c.name : c.name + ', ' + rangeOf(c);
}

// The block's own two lines: the file on top, then its range and length, so
// a narrow block still shows which piece it is when the name is cut short.
function factsFor(c) {
  return (isWhole(c) ? [] : [rangeOf(c)]).concat(secs(lengthOf(c))).join('  ·  ');
}

// The icon lives in a <template> in the page, so it is drawn once in markup.
function trashIcon() {
  return el('trash-icon').content.firstElementChild.cloneNode(true);
}

function fillBadge(badge, c) {
  if (!badge) return;
  badge.hidden = c.speed === 1;
  badge.textContent = rate(c.speed);
}

function clipNode(c, i) {
  const node = document.createElement('div');
  node.className = 'clip' + (i === selected ? ' sel' : '');
  node.dataset.i = String(i);
  node.title = blockTitle(c);
  cssVar(node, '--span', String(lengthOf(c)));

  const gripIn = document.createElement('span');
  gripIn.className = 'grip grip-in';
  gripIn.dataset.edge = 'in';
  gripIn.title = 'Drag to trim the start';

  const body = document.createElement('div');
  body.className = 'clip-body';
  const name = document.createElement('p');
  name.className = 'clip-name';
  name.textContent = c.name;            // textContent, so an odd filename stays text
  const facts = document.createElement('p');
  facts.className = 'clip-facts';
  facts.textContent = factsFor(c);
  body.append(name, facts);

  const badge = document.createElement('span');
  badge.className = 'clip-speed';
  badge.title = 'Speed in the finished video';
  fillBadge(badge, c);

  const bar = document.createElement('span');
  bar.className = 'clip-bar';

  const gripOut = document.createElement('span');
  gripOut.className = 'grip grip-out';
  gripOut.dataset.edge = 'out';
  gripOut.title = 'Drag to trim the end';

  const trash = document.createElement('button');
  trash.type = 'button';
  trash.className = 'clip-trash';
  trash.title = 'Remove from the timeline (Delete)';
  trash.setAttribute('aria-label', 'Remove ' + labelOf(c) + ' from the timeline');
  trash.appendChild(trashIcon());

  // The speed mark and the can share the block's top right corner. The inner
  // row is sticky, so on a block longer than the window they stay at the
  // visible right edge instead of off screen at the block's real end.
  const corner = document.createElement('div');
  corner.className = 'clip-corner';
  const stick = document.createElement('div');
  stick.className = 'clip-corner-stick';
  stick.append(badge, trash);
  corner.appendChild(stick);

  node.append(gripIn, body, bar, corner, gripOut);
  return node;
}

function joinNode(j) {
  const kind = (project.clips[j + 1] || {}).transition || 'cut';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tr tr-' + kind;
  b.dataset.j = String(j);
  b.title = JOIN_LABEL[kind] + ': how block ' + (j + 1) + ' meets block ' + (j + 2)
    + (kind === 'cut' ? '' : ', over ' + secs(overlapAt(j)))
    + '. Click to choose cut, fade or slide.';
  b.setAttribute('aria-haspopup', 'menu');
  const mark = document.createElement('span');
  mark.className = 'tr-mark';
  const label = document.createElement('span');
  label.className = 'tr-word';
  label.textContent = JOIN_LABEL[kind] || 'Cut';
  b.append(mark, label);
  return b;
}

function drawTimeline() {
  const track = el('track');
  cssVar(el('tl'), '--zoom', String(zoomNow));
  track.textContent = '';
  project.clips.forEach((c, i) => {
    if (i > 0) track.appendChild(joinNode(i - 1));
    track.appendChild(clipNode(c, i));
  });
  drawLane();
}

// The scrub strip, one segment under each block, laid out from the blocks
// themselves. Ticks fall at a round number of seconds no closer than 12px.
const TICKS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
function drawLane() {
  const lane = el('lane');
  const begins = starts();
  lane.textContent = '';
  project.clips.forEach((c, i) => {
    const node = clipNodeAt(i);
    if (!node) return;
    const perSec = node.offsetWidth / Math.max(0.01, lengthOf(c));
    const step = TICKS.find((s) => s * perSec >= 12) || TICKS[TICKS.length - 1];
    const seg = document.createElement('div');
    seg.className = 'seg';
    cssVar(seg, '--x', node.offsetLeft + 'px');
    cssVar(seg, '--w', node.offsetWidth + 'px');
    cssVar(seg, '--tick', (step * perSec).toFixed(2) + 'px');
    const at = document.createElement('span');
    at.className = 'seg-at';
    at.textContent = clock(begins[i]);
    seg.append(at);
    lane.append(seg);
  });
}

// Used while a trim is being pulled, when redrawing the whole track would
// destroy the very element holding the pointer capture.
function refreshClipNode(i) {
  const node = clipNodeAt(i);
  if (!node) return;
  cssVar(node, '--span', String(lengthOf(project.clips[i])));
  node.querySelector('.clip-facts').textContent = factsFor(project.clips[i]);
  node.title = blockTitle(project.clips[i]);
  fillBadge(node.querySelector('.clip-speed'), project.clips[i]);
  drawLane();
}

function afterChange() {
  fixJoins();
  if (!restoring) record();
  drawTray();
  if (!project.clips.length && !tray.length) return startAgain(true);
  if (selected >= project.clips.length) selected = project.clips.length - 1;
  el('go').disabled = busy || !project.clips.length;
  if (!project.clips.length) {
    // Everything is in the tray: nothing to preview.
    pause();
    showing = -1;
    showingSrc = null;
    el('video').removeAttribute('src');
    el('video').load();
  }
  drawTimeline();
  drawClipPanel();
  refreshOutput();
  seek(Math.min(playhead, total()));   // the edit may have moved it onto another clip
}

/* ================================================================ help === */

/* Help where it is used (decided 2026-11-16: no brick of help text listing
   every action): the window shows what it can do. Hover titles on what you
   drag, the joins as chips with a picker, and a short "?" list of the keys. */
el('help').addEventListener('click', () => el('help-keys').showModal());

/* ====================================================== undo and redo === */

/* Every change to the project goes through afterChange, so that is where the
   history is kept: after each one the project is written down as JSON, and
   if it differs from the last copy, the last copy goes on the undo stack.
   A slider drag lands once, on its change event, not on every step. The
   history lasts as long as the window (walk, 2026-11-16). */

const history = { undo: [], redo: [], last: null, lastSel: -1 };
const HISTORY_MAX = 200;
let restoring = false;

function snapshot() {
  return JSON.stringify({ clips: project.clips, tray, format: project.format, pan: project.pan });
}

function record() {
  const now = snapshot();
  if (history.last !== null && now !== history.last) {
    history.undo.push({ state: history.last, selected: history.lastSel });
    if (history.undo.length > HISTORY_MAX) history.undo.shift();
    history.redo.length = 0;
  }
  history.last = now;
  history.lastSel = selected;
  drawHistory();
}

function forget() {
  history.undo.length = 0;
  history.redo.length = 0;
  history.last = null;
  history.lastSel = -1;
  drawHistory();
}

function drawHistory() {
  el('undo').disabled = busy || !history.undo.length;
  el('redo').disabled = busy || !history.redo.length;
  const mac = /Mac/.test(navigator.platform);
  el('undo').title = 'Undo (' + (mac ? 'Cmd+Z' : 'Ctrl+Z') + ')';
  el('redo').title = 'Redo (' + (mac ? 'Shift+Cmd+Z' : 'Ctrl+Y') + ')';
}

function restore(entry) {
  const s = JSON.parse(entry.state);
  pause();
  project.clips.splice(0, project.clips.length, ...s.clips);
  tray.splice(0, tray.length, ...(s.tray || []));
  project.format = s.format;
  project.pan = s.pan;
  el('format').value = s.format;
  history.last = entry.state;
  history.lastSel = entry.selected;
  hide('error');
  hide('done');
  if (!project.clips.length && !tray.length) {
    startAgain(true);
  } else {
    showEditor(true);
    selected = project.clips.length ? clamp(entry.selected, 0, project.clips.length - 1) : -1;
    restoring = true;
    try { afterChange(); } finally { restoring = false; }
  }
  drawHistory();
}

function step(from, to) {
  if (busy || carry || laneDrag || !from.length) return;
  // A slider still being dragged has changed the project without landing.
  // Land it first, so undo takes back exactly that.
  if (history.last !== null && snapshot() !== history.last) record();
  to.push({ state: history.last, selected });
  restore(from.pop());
}

function undo() { step(history.undo, history.redo); }
function redo() { step(history.redo, history.undo); }

el('undo').addEventListener('click', undo);
el('redo').addEventListener('click', redo);
bridge.onHistory((which) => (which === 'redo' ? redo() : undo()));

/* ============================== moving, trimming, splitting and joining === */

function selectClip(i) {
  selected = i;
  [...el('track').querySelectorAll('.clip')].forEach((n) => {
    n.classList.toggle('sel', Number(n.dataset.i) === i);
  });
  drawClipPanel();
}

function moveClip(from, to) {
  if (from < 0) return;
  let target = to;
  if (target > from) target -= 1;
  if (target === from) return;
  const [c] = project.clips.splice(from, 1);
  project.clips.splice(target, 0, c);
  selected = target;
  afterChange();
}

function removeClip(i) {
  if (busy || i < 0 || i >= project.clips.length) return;
  project.clips.splice(i, 1);
  selected = Math.min(i, project.clips.length - 1);
  afterChange();
}

function splitHere() {
  if (busy || !project.clips.length) return;
  const at = locate(playhead);
  const c = project.clips[at.i];
  const cut = at.sourceTime;
  if (cut <= c.in + MIN_CLIP || cut >= c.out - MIN_CLIP) {
    return complain('There is not enough on both sides of the playhead to split there.');
  }
  // plan.splitAt is the one implementation of what a split means. Replace the
  // contents in place rather than rebinding, so nothing holding the array is
  // left pointing at the old one.
  const next = plan.splitAt(project.clips, at.i, cut);
  project.clips.splice(0, project.clips.length, ...next);
  selected = at.i + 1;
  hide('error');
  afterChange();
}

/* The joins (walk, 2026-11-16: "the transition stuff is something I
   completely missed"). Each is a chip over the seam showing its kind; a click
   opens a small picker of the three, each with a moving picture of what it
   does, and choosing one plays the seam so the effect shows at once. */
let pickerFor = -1;

function openPicker(j, chip) {
  const c = project.clips[j + 1];
  if (!c || busy) return;
  pickerFor = j;
  const r = chip.getBoundingClientRect();
  const picker = el('join-picker');
  cssVar(picker, '--jx', Math.round(r.left + r.width / 2) + 'px');
  cssVar(picker, '--jy', Math.round(r.bottom) + 'px');
  for (const b of picker.querySelectorAll('.jp-opt')) {
    const on = b.dataset.kind === c.transition;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  picker.hidden = false;
  (picker.querySelector('.jp-opt.on') || picker.querySelector('.jp-opt')).focus();
}

function closePicker() {
  el('join-picker').hidden = true;
  pickerFor = -1;
}

function setJoin(j, kind) {
  const c = project.clips[j + 1];
  closePicker();
  if (!c || !plan.TRANSITIONS[kind]) return;
  if (c.transition !== kind) {
    c.transition = kind;
    afterChange();
  }
  previewSeam(j);
}

el('join-picker').addEventListener('click', (e) => {
  const opt = e.target.closest('.jp-opt');
  if (opt && pickerFor >= 0) setJoin(pickerFor, opt.dataset.kind);
});
el('join-picker').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
});
document.addEventListener('pointerdown', (e) => {
  if (el('join-picker').hidden) return;
  if (e.target.closest('#join-picker, .tr')) return;
  closePicker();
});

/* Playing a seam: a second from either side. The preview is one video
   element, which cannot blend two clips, so for a fade or a slide a second
   video is laid over it for the length of the join, doing what the export's
   xfade does: the next clip fades or slides in over the end of this one. */
let seamRaf = 0;

function stopSeam() {
  cancelAnimationFrame(seamRaf);
  seamRaf = 0;
  el('frame').classList.remove('seam-fade', 'seam-slide');
  const vb = el('video-b');
  vb.pause();
  vb.removeAttribute('src');
  vb.load();
}

function previewSeam(j) {
  const b = project.clips[j + 1];
  if (!b || busy) return;
  stopSeam();
  const t0 = starts()[j + 1];
  const over = overlapAt(j);
  const blend = b.transition !== 'cut' && over > 0;
  const vb = el('video-b');
  if (blend) {
    vb.muted = true;
    vb.src = bridge.fileUrl(b.src);
    vb.currentTime = b.in;
    vb.playbackRate = b.speed;
    cssVar(el('frame'), '--seam', over + 's');
  }
  seek(Math.max(0, t0 - 1));
  play();
  let started = false;
  const watch = () => {
    if (!playing) return stopSeam();
    if (blend && !started && playhead >= t0) {
      started = true;
      vb.play().catch(() => {});
      el('frame').classList.add('seam-' + b.transition);
    }
    if (blend && started && playhead >= t0 + over + 0.1 && el('frame').classList.contains('seam-' + b.transition)) {
      // The plain preview starts the next clip from its beginning; move it on
      // to where the overlay got to, then lift the overlay.
      seek(Math.max(playhead, t0 + over));
      el('frame').classList.remove('seam-fade', 'seam-slide');
    }
    if (playhead >= t0 + Math.max(1, over + 0.5)) { pause(); return stopSeam(); }
    seamRaf = requestAnimationFrame(watch);
  };
  seamRaf = requestAnimationFrame(watch);
}

/* Scrolling the strip under a drag. The browser's own drag and drop was used
   here once, and while it runs the page gets no wheel events and only a
   sliver of edge to scroll by, so a long timeline could not be reached with
   a block in hand (walk, 2026-11-16). Every drag on the strip is a
   pointer drag now: the strip scrolls by itself when the pointer nears
   either end, faster the closer it gets, and the wheel keeps working. */

let edgeX = null;
let edgeRaf = 0;

function edgeScroll(clientX) {
  edgeX = clientX;
  if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeStep);
}
function edgeStop() {
  edgeX = null;
  if (edgeRaf) cancelAnimationFrame(edgeRaf);
  edgeRaf = 0;
}
function edgeStep() {
  edgeRaf = 0;
  if (edgeX === null) return;
  const box = el('tl-scroll').getBoundingClientRect();
  const zone = Math.min(72, box.width / 4);
  let push = 0;
  if (edgeX < box.left + zone) push = -(box.left + zone - edgeX) / zone;
  else if (edgeX > box.right - zone) push = (edgeX - (box.right - zone)) / zone;
  push = clamp(push, -1.6, 1.6);
  if (push) el('tl-scroll').scrollLeft += Math.sign(push) * push * push * 24;
  edgeRaf = requestAnimationFrame(edgeStep);
}

// Whatever is being dragged follows the content when the strip scrolls, by the
// edge, the wheel or a trackpad.
el('tl-scroll').addEventListener('scroll', () => { if (active) active.refresh(); });

el('track').addEventListener('click', (e) => {
  if (swallowClick) return;
  const trash = e.target.closest('.clip-trash');
  if (trash) return askRemove(Number(trash.closest('.clip').dataset.i));
  const join = e.target.closest('.tr');
  if (join) return pickerFor === Number(join.dataset.j) ? closePicker() : openPicker(Number(join.dataset.j), join);
  const node = e.target.closest('.clip');
  if (node) selectClip(Number(node.dataset.i));
});

el('track').addEventListener('dblclick', (e) => {
  if (e.target.closest('.clip-trash')) return;
  const node = e.target.closest('.clip');
  if (!node) return;
  seek(starts()[Number(node.dataset.i)]);
});

function dropIndexAt(clientX) {
  const x = clientX - el('tl').getBoundingClientRect().left;
  const nodes = [...el('track').querySelectorAll('.clip')];
  for (const n of nodes) {
    if (x < n.offsetLeft + n.offsetWidth / 2) return Number(n.dataset.i);
  }
  return nodes.length;
}

function markDrop(target) {
  [...el('track').querySelectorAll('.clip')].forEach((n) => {
    const i = Number(n.dataset.i);
    n.classList.toggle('drop-before', target === i);
    n.classList.toggle('drop-after', target === project.clips.length && i === project.clips.length - 1);
  });
}

/* Carrying a block. A press only becomes a carry once the pointer has moved a
   few pixels, so a plain click still selects. */
el('track').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || busy || carry || e.target.closest('.grip, .clip-trash')) return;
  const node = e.target.closest('.clip');
  if (!node) return;
  const box = node.getBoundingClientRect();
  const from = Number(node.dataset.i);
  carry = { from, x: e.clientX, y: e.clientY, moved: false, ghost: null };
  const x0 = e.clientX;
  const y0 = e.clientY;
  node.setPointerCapture(e.pointerId);

  const placeGhost = () => {
    cssVar(carry.ghost, '--gx', (carry.x - (x0 - box.left)) + 'px');
    cssVar(carry.ghost, '--gy', (carry.y - (y0 - box.top)) + 'px');
  };
  const lift = () => {
    carry.moved = true;
    dragFrom = from;
    node.classList.add('lifted');
    el('tl').classList.add('carrying');
    carry.ghost = clipNode(project.clips[from], from);
    carry.ghost.classList.remove('sel');
    carry.ghost.classList.add('ghost');
    el('tl').appendChild(carry.ghost);
    active = { refresh: () => markDrop(dropIndexAt(carry.x)) };
    refreshCutHere();
  };
  const onMove = (ev) => {
    carry.x = ev.clientX;
    carry.y = ev.clientY;
    if (!carry.moved) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      lift();
    }
    placeGhost();
    const toTray = overTray(carry.x, carry.y);
    el('tray').classList.toggle('over', toTray);
    markDrop(toTray ? -1 : dropIndexAt(carry.x));
    if (toTray) edgeStop(); else edgeScroll(carry.x);
  };
  const finish = (commit) => {
    node.removeEventListener('pointermove', onMove);
    node.removeEventListener('pointerup', onUp);
    node.removeEventListener('pointercancel', onCancel);
    edgeStop();
    active = null;
    const was = carry;
    carry = null;
    if (!was.moved) return;
    was.ghost.remove();
    node.classList.remove('lifted');
    el('tl').classList.remove('carrying');
    el('tray').classList.remove('over');
    markDrop(-1);
    dragFrom = -1;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    if (commit && overTray(was.x, was.y)) parkClip(from);
    else if (commit) moveClip(from, dropIndexAt(was.x));
    else refreshCutHere();
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  carry.cancel = onCancel;
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onCancel);
});

/* ============================================================== the tray === */

function inside(node, x, y, slack = 0) {
  if (!node || node.hidden) return false;
  const r = node.getBoundingClientRect();
  return x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack;
}
function overTray(x, y) { return inside(el('tray'), x, y); }
function overTimeline(x, y) { return inside(el('tl-scroll'), x, y, 24); }

// Setting a block aside is not removing it, so there is no question.
function parkClip(i) {
  if (busy || i < 0 || i >= project.clips.length) return;
  const [c] = project.clips.splice(i, 1);
  c.transition = 'cut';           // it joins whatever it lands next to afresh
  tray.push(c);
  selected = Math.min(i, project.clips.length - 1);
  afterChange();
}

function unparkClip(k, at) {
  if (busy || k < 0 || k >= tray.length) return;
  const [c] = tray.splice(k, 1);
  const to = clamp(at, 0, project.clips.length);
  project.clips.splice(to, 0, c);
  selected = to;
  afterChange();
}

function dropFromTray(k) {
  if (busy || k < 0 || k >= tray.length) return;
  tray.splice(k, 1);
  afterChange();
}

/* The tray is a bin of picture tiles (walk, 2026-11-16: "It should be
   like an icon image files"). Each tile shows one frame from about a tenth of
   the way into its own range (the very first frame is often black), made by
   main with one quick ffmpeg call and kept, with a film icon until then or if
   it fails. The tile is what you drag. */
const thumbs = new Map();   // src + time -> data: URL, or null when there is none

function thumbKey(c) {
  const at = Math.round((c.in + (c.out - c.in) * 0.1) * 10) / 10;
  return { key: c.src + '\n' + at, at };
}

function fillPicture(pic, c) {
  const { key, at } = thumbKey(c);
  pic.dataset.thumb = key;
  const put = (url) => {
    if (!url || pic.dataset.thumb !== key) return;
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    pic.querySelector('.tile-film')?.remove();
    pic.prepend(img);
  };
  if (thumbs.has(key)) return put(thumbs.get(key));
  thumbs.set(key, null);
  bridge.thumbnail(c.src, at).then((url) => {
    thumbs.set(key, url || null);
    document.querySelectorAll('#tray-list .tile-pic').forEach((node) => {
      if (node.dataset.thumb === key && !node.querySelector('img')) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = url;
        if (url) { node.querySelector('.tile-film')?.remove(); node.prepend(img); }
      }
    });
  }).catch(() => {});
}

function iconFrom(id) { return el(id).content.firstElementChild.cloneNode(true); }

function iconButton(cls, icon, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile-btn ' + cls;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(iconFrom(icon));
  return b;
}

function trayRow(c, k) {
  const row = document.createElement('li');
  row.className = 'tray-row tile';
  row.dataset.k = String(k);
  row.title = labelOf(c) + '. Drag it onto the timeline, or double-click to add it to the end.';
  const pic = document.createElement('div');
  pic.className = 'tile-pic';
  const film = iconFrom('film-icon');
  film.classList.add('tile-film');
  const len = document.createElement('span');
  len.className = 'tile-len';
  len.textContent = secs(lengthOf(c)) + (c.speed !== 1 ? ' ' + rate(c.speed) : '');
  pic.append(film, len);
  fillPicture(pic, c);
  const what = document.createElement('p');
  what.className = 'what';
  what.textContent = c.name;
  row.append(pic, what);
  if (!isWhole(c)) {
    const range = document.createElement('p');
    range.className = 'tile-range';
    range.textContent = rangeOf(c);
    row.appendChild(range);
  }
  const actions = document.createElement('div');
  actions.className = 'tile-actions';
  actions.append(
    iconButton('tray-add', 'plus-icon', 'Add ' + labelOf(c) + ' to the end of the timeline'),
    iconButton('tray-out', 'cross-icon', 'Take ' + labelOf(c) + ' out of the tray'));
  row.appendChild(actions);
  return row;
}

function pendingRow(w) {
  const row = document.createElement('li');
  row.className = 'tray-row tile pending';
  row.title = 'Reading ' + w.name;
  const pic = document.createElement('div');
  pic.className = 'tile-pic';
  const spin = document.createElement('span');
  spin.className = 'spin';
  spin.setAttribute('aria-hidden', 'true');
  pic.appendChild(spin);
  const what = document.createElement('p');
  what.className = 'what';
  what.textContent = w.name;
  row.append(pic, what);
  return row;
}

function drawTray() {
  const list = el('tray-list');
  list.textContent = '';
  tray.forEach((c, k) => list.appendChild(trayRow(c, k)));
  trayPending.forEach((w) => list.appendChild(pendingRow(w)));
  el('tray-hint').textContent = tray.length || trayPending.length
    ? 'Only what is on the timeline goes into the video.'
    : 'Drag a block here to set it aside.';
  el('track').dataset.empty = tray.length ? 'Drag a clip from the tray to start cutting' : 'Add videos to start';
}

el('tray-list').addEventListener('click', (e) => {
  const row = e.target.closest('.tray-row');
  if (!row || row.classList.contains('pending')) return;
  const k = Number(row.dataset.k);
  if (e.target.closest('.tray-add')) return unparkClip(k, project.clips.length);
  if (e.target.closest('.tray-out')) return dropFromTray(k);
});

// A quick way in, since clips go back and forth a lot.
el('tray-list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.tray-row');
  if (!row || row.classList.contains('pending') || e.target.closest('button')) return;
  unparkClip(Number(row.dataset.k), project.clips.length);
});

/* Carrying a clip from the tray to the timeline, with the same insert marker
   a carried block uses. */
el('tray-list').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || busy || carry || e.target.closest('button')) return;
  const row = e.target.closest('.tray-row');
  if (!row || row.classList.contains('pending')) return;
  const k = Number(row.dataset.k);
  const c = tray[k];
  const x0 = e.clientX;
  const y0 = e.clientY;
  carry = { tray: k, x: x0, y: y0, moved: false, ghost: null };
  row.setPointerCapture(e.pointerId);

  const show = () => {
    const on = overTimeline(carry.x, carry.y);
    el('tl-scroll').classList.toggle('drop-here', on);
    markDrop(on ? dropIndexAt(carry.x) : -1);
    return on;
  };
  const place = () => {
    cssVar(carry.ghost, '--gx', (carry.x - 24) + 'px');
    cssVar(carry.ghost, '--gy', (carry.y - 20) + 'px');
  };
  const lift = () => {
    carry.moved = true;
    row.classList.add('lifted');
    el('tl').classList.add('carrying');
    carry.ghost = clipNode(c, -1);
    carry.ghost.classList.remove('sel');
    carry.ghost.classList.add('ghost');
    el('tl').appendChild(carry.ghost);
    active = { refresh: show };
  };
  const onMove = (ev) => {
    carry.x = ev.clientX;
    carry.y = ev.clientY;
    if (!carry.moved) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      lift();
    }
    place();
    if (show()) edgeScroll(carry.x); else edgeStop();
  };
  const finish = (commit) => {
    row.removeEventListener('pointermove', onMove);
    row.removeEventListener('pointerup', onUp);
    row.removeEventListener('pointercancel', onCancel);
    edgeStop();
    active = null;
    const was = carry;
    carry = null;
    if (!was.moved) return;
    was.ghost.remove();
    row.classList.remove('lifted');
    el('tl').classList.remove('carrying');
    el('tl-scroll').classList.remove('drop-here');
    markDrop(-1);
    if (commit && overTimeline(was.x, was.y)) unparkClip(k, dropIndexAt(was.x));
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  carry.cancel = onCancel;
  row.addEventListener('pointermove', onMove);
  row.addEventListener('pointerup', onUp);
  row.addEventListener('pointercancel', onCancel);
});

/* Trim handles. The block is redrawn in place rather than the whole track,
   because rebuilding the track would delete the element holding the pointer. */
el('track').addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.grip');
  if (!grip || busy) return;
  const node = grip.closest('.clip');
  const i = Number(node.dataset.i);
  const c = project.clips[i];
  const edge = grip.dataset.edge;
  const startX = e.clientX;
  const startScroll = el('tl-scroll').scrollLeft;
  const startAt = edge === 'in' ? c.in : c.out;
  let lastX = e.clientX;
  // Pixels per second of finished video for this block specifically, since a
  // short block is held wider than the zoom alone would make it.
  const scale = node.offsetWidth / Math.max(0.01, lengthOf(c));

  e.preventDefault();
  grip.classList.add('pulling');
  grip.setPointerCapture(e.pointerId);
  selectClip(i);
  pause();

  // Measured against the content rather than the window, so the edge keeps
  // following the pointer when the strip scrolls under it.
  const pull = () => {
    const moved = lastX - startX + el('tl-scroll').scrollLeft - startScroll;
    const shift = (moved / scale) * c.speed;   // finished seconds to source seconds
    if (edge === 'in') c.in = clamp(startAt + shift, 0, c.out - MIN_CLIP);
    else c.out = clamp(startAt + shift, c.in + MIN_CLIP, c.duration);
    refreshClipNode(i);
    drawClipPanel();
    paint();
  };
  active = { refresh: pull };
  const onMove = (ev) => {
    lastX = ev.clientX;
    pull();
    // Only the out edge carries the strip with it: lengthening a block from
    // its far end is the one that runs off screen.
    if (edge === 'out') edgeScroll(lastX);
  };
  const onUp = () => {
    edgeStop();
    active = null;
    grip.removeEventListener('pointermove', onMove);
    grip.removeEventListener('pointerup', onUp);
    grip.removeEventListener('pointercancel', onUp);
    grip.classList.remove('pulling');
    afterChange();
  };
  grip.addEventListener('pointermove', onMove);
  grip.addEventListener('pointerup', onUp);
  grip.addEventListener('pointercancel', onUp);
});

// Clicking the empty part of the strip moves the playhead there.
el('tl-scroll').addEventListener('click', (e) => {
  if (e.target.closest('.clip') || e.target.closest('.tr')) return;
  if (e.target.closest('.lane') || e.target.closest('.cut-here')) return;
  if (!project.clips.length) return;
  const x = e.clientX - el('tl').getBoundingClientRect().left;
  const nodes = [...el('track').querySelectorAll('.clip')];
  const begins = starts();
  for (const n of nodes) {
    if (x >= n.offsetLeft && x <= n.offsetLeft + n.offsetWidth) {
      const i = Number(n.dataset.i);
      const frac = (x - n.offsetLeft) / n.offsetWidth;
      pause();
      return seek(begins[i] + frac * lengthOf(project.clips[i]));
    }
  }
});

/* The scrub strip under the blocks. Press anywhere on it and drag: the
   playhead and the picture follow, the strip scrolls at either end, and Split
   waits where you let go (walk, 2026-11-16). */
el('lane').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || busy || !project.clips.length) return;
  const lane = el('lane');
  e.preventDefault();
  pause();
  laneDrag = { x: e.clientX };
  lane.classList.add('dragging');
  lane.setPointerCapture(e.pointerId);
  const to = () => seek(timeAtX(laneDrag.x - el('tl').getBoundingClientRect().left));
  active = { refresh: to };
  to();
  const onMove = (ev) => {
    laneDrag.x = ev.clientX;
    to();
    edgeScroll(laneDrag.x);
  };
  const onUp = () => {
    lane.removeEventListener('pointermove', onMove);
    lane.removeEventListener('pointerup', onUp);
    lane.removeEventListener('pointercancel', onUp);
    lane.classList.remove('dragging');
    edgeStop();
    active = null;
    laneDrag = null;
    refreshCutHere();
  };
  lane.addEventListener('pointermove', onMove);
  lane.addEventListener('pointerup', onUp);
  lane.addEventListener('pointercancel', onUp);
});

el('cut-here').addEventListener('click', splitHere);

/* Zoom, from the slider or a pinch. The moment under the anchor stays where
   it is: the pointer for a pinch, the playhead for the slider when it is on
   screen, otherwise the middle. */
function setZoom(value, anchorX) {
  const box = el('tl-scroll').getBoundingClientRect();
  const tlLeft = () => el('tl').getBoundingClientRect().left;
  let anchor = anchorX;
  if (anchor === undefined) {
    const ph = tlLeft() + playheadPx();
    anchor = ph >= box.left && ph <= box.right ? ph : box.left + box.width / 2;
  }
  const t = timeAtX(anchor - tlLeft());
  zoomNow = clamp(value, 6, 140);
  el('zoom').value = String(Math.round(zoomNow));
  cssVar(el('tl'), '--zoom', String(zoomNow));
  drawLane();
  if (project.clips.length) el('tl-scroll').scrollLeft += tlLeft() + pxAt(t) - anchor;
  paint();
}

el('zoom').addEventListener('input', () => setZoom(num(el('zoom').value, 34)));

/* The wheel. A mouse wheel or an up-and-down swipe over the timeline moves it
   sideways, since sideways is the only way it goes; a sideways swipe already
   does. A pinch arrives as a wheel with ctrlKey set, and zooms. */
el('tl-scroll').addEventListener('wheel', (e) => {
  const box = el('tl-scroll');
  if (e.ctrlKey) {
    e.preventDefault();
    if (project.clips.length) setZoom(zoomNow * Math.exp(-e.deltaY * 0.01), e.clientX);
    return;
  }
  if (box.scrollWidth <= box.clientWidth + 1) return;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientWidth : 1;
  box.scrollLeft += e.deltaY * unit;
}, { passive: false });

/* ========================================================== the side panel === */

function drawClipPanel() {
  const c = project.clips[selected];
  el('clip-panel').hidden = !c;
  if (!c) return;
  el('clip-name').textContent = labelOf(c);
  el('clip-facts').textContent = [
    'keeping ' + secs(c.out - c.in) + ' of ' + secs(c.duration),
    c.w && c.h ? c.w + ' x ' + c.h : '',
    c.hasAudio ? 'with sound' : 'silent',
  ].filter(Boolean).join('  ·  ');
  el('speed').value = String(Math.round(c.speed * 100));
  drawSpeed(c);
}

// The words under the speed slider: what the export does to this clip, in
// its own numbers, so nobody has to guess whether it is only the preview.
function speedNote(c) {
  const kept = c.out - c.in;
  const s = c.speed;
  if (s === 1) return 'Plays at its normal speed in the finished video.';
  const how = s === 2 ? 'twice as fast'
    : s === 0.5 ? 'at half speed'
    : s > 1 ? rate(s).slice(0, -1) + ' times as fast'
    : 'slower, at ' + rate(s).slice(0, -1) + ' times its normal speed';
  const sound = c.hasAudio ? ' The sound keeps its pitch.' : '';
  return rate(s) + ': this clip plays ' + how + ' in the finished video, '
    + secs(kept) + ' becomes ' + secs(kept / s) + '.' + sound;
}

function drawSpeed(c) {
  el('speed-read').textContent = rate(c.speed);
  el('speed-note').textContent = speedNote(c);
  for (const b of el('speed-picks').querySelectorAll('.pick')) {
    const on = Math.abs(num(b.dataset.speed, 1) - c.speed) < 0.001;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function setSpeed(value) {
  const c = project.clips[selected];
  if (!c) return null;
  c.speed = clamp(value, 0.25, 4);
  drawSpeed(c);
  refreshClipNode(selected);
  paint();
  return c;
}

el('speed').addEventListener('input', () => {
  setSpeed(num(el('speed').value, 100) / 100);
});
el('speed').addEventListener('change', () => afterChange());

el('speed-picks').addEventListener('click', (e) => {
  const b = e.target.closest('.pick');
  if (!b || busy) return;
  const c = setSpeed(num(b.dataset.speed, 1));
  if (!c) return;
  el('speed').value = String(Math.round(c.speed * 100));
  afterChange();
});

/* Asking before a clip is removed (walk, 2026-11-16). "Don't ask again"
   is kept in this window's own storage, so it lasts between sessions; if the
   storage cannot be read, it simply asks. Either way, Undo brings it back. */
const NO_ASK_KEY = 'justcut.removeWithoutAsking';
let removing = -1;

function askingIsOff() {
  try { return localStorage.getItem(NO_ASK_KEY) === '1'; } catch (e) { return false; }
}

function askRemove(i) {
  if (busy || i < 0 || i >= project.clips.length) return;
  if (askingIsOff()) return removeClip(i);
  removing = i;
  selectClip(i);
  // Short, as asked for in the walk: the name and the range say what goes.
  // A whole file says "from the timeline", so it cannot read as deleting the file.
  const c = project.clips[i];
  el('ask-remove-title').textContent = isWhole(c)
    ? 'Remove ' + c.name + ' from the timeline?'
    : 'Remove ' + labelOf(c) + '?';
  el('ask-remove-never').checked = false;
  el('ask-remove').returnValue = '';    // Escape leaves the last answer otherwise
  el('ask-remove').showModal();
  el('ask-remove-yes').focus();
}

el('ask-remove').addEventListener('close', () => {
  const i = removing;
  removing = -1;
  if (el('ask-remove').returnValue !== 'remove') return;
  if (el('ask-remove-never').checked) {
    try { localStorage.setItem(NO_ASK_KEY, '1'); } catch (e) { /* asks next time */ }
  }
  removeClip(i);
  drawSettings();
});

/* ========================================================= the output shape === */

// Both plan.targetSize and plan.cropRect describe rectangles, and either
// spelling of the field names is readable here.
function rectOf(r) {
  if (!r) return null;
  return {
    x: num(r.x, 0),
    y: num(r.y, 0),
    w: num(r.w !== undefined ? r.w : r.width, 0),
    h: num(r.h !== undefined ? r.h : r.height, 0),
  };
}

function refreshOutput() {
  const first = project.clips[0];
  if (!first) return;

  const size = rectOf(outSize());
  const ratio = size && size.h ? size.w / size.h : 16 / 9;
  cssVar(el('frame'), '--frame-ar', String(Math.round(ratio * 10000) / 10000));
  el('format-note').textContent = size && size.w && size.h
    ? size.w + ' by ' + size.h + ' pixels'
    : '';

  // The pan only earns its place when the chosen shape actually cuts something
  // off, and then only on the side it cuts.
  const crop = rectOf(outCrop());
  const cropsX = Boolean(crop && first.w && crop.w > 0 && crop.w < first.w - 1);
  const cropsY = Boolean(crop && first.h && crop.h > 0 && crop.h < first.h - 1);
  panAxis = cropsX ? 'x' : cropsY ? 'y' : null;

  el('pan-field').hidden = !panAxis;
  el('frame').classList.toggle('crop', Boolean(panAxis));

  if (panAxis) {
    el('pan-a').textContent = panAxis === 'x' ? 'Left' : 'Top';
    el('pan-b').textContent = panAxis === 'x' ? 'Right' : 'Bottom';
    el('pan').value = String(Math.round(project.pan[panAxis] * 100));
    const kept = panAxis === 'x'
      ? Math.round((crop.w / first.w) * 100)
      : Math.round((crop.h / first.h) * 100);
    el('pan-note').textContent = 'Keeping ' + kept + '% of the '
      + (panAxis === 'x' ? 'width' : 'height') + '. Slide it to choose which part.';
  }

  cssVar(el('frame'), '--pan-x', Math.round(project.pan.x * 100) + '%');
  cssVar(el('frame'), '--pan-y', Math.round(project.pan.y * 100) + '%');
}

el('format').addEventListener('change', () => {
  project.format = el('format').value;
  refreshOutput();
  record();
});

el('pan').addEventListener('input', () => {
  if (!panAxis) return;
  project.pan[panAxis] = clamp(num(el('pan').value, 50) / 100, 0, 1);
  cssVar(el('frame'), '--pan-x', Math.round(project.pan.x * 100) + '%');
  cssVar(el('frame'), '--pan-y', Math.round(project.pan.y * 100) + '%');
});
el('pan').addEventListener('change', () => record());

/* ============================================================= exporting === */

function suggestedName() {
  const first = project.clips[0];
  return (first ? stem(first.name) : 'video') + '-edit.mp4';
}

function setBusy(on) {
  busy = on;
  ['go', 'split', 'add', 'clear', 'format', 'speed', 'undo', 'redo'].forEach((id) => {
    el(id).disabled = on;
  });
  for (const b of el('speed-picks').querySelectorAll('.pick')) b.disabled = on;
  drawHistory();
  refreshCutHere();
}

bridge.onExportProgress((p) => {
  const fraction = clamp(num(p && p.progress, 0), 0, 1);
  const pct = Math.round(fraction * 100);
  cssVar(el('fill'), '--fill', pct + '%');
  el('stage').textContent = (p && p.stage) || 'Working';
  el('pct').textContent = pct + '%';
});

async function exportNow() {
  if (busy || !project.clips.length) return;
  hide('error');
  hide('done');

  const problems = problemsWith(project);
  if (problems.length) return complain(problems.join('\n'));

  const out = await bridge.chooseOutput(suggestedName());
  if (!out) return;

  pause();
  setBusy(true);
  cssVar(el('fill'), '--fill', '0%');
  el('stage').textContent = 'Getting started';
  el('pct').textContent = '';
  show('working');
  bringIntoView('working');

  let r;
  try {
    r = await bridge.exportProject(project, out);
  } catch (e) {
    r = { ok: false, error: plainError(e) };
  }

  setBusy(false);
  hide('working');

  if (!r || !r.ok) {
    if (!(r && r.cancelled)) complain((r && (r.error || r.message)) || 'The export did not finish.');
    return;
  }

  const path = r.path || out;
  el('result').textContent = 'Done.';
  el('detail').textContent = path;
  el('reveal').onclick = () => bridge.revealFile(path);
  show('done');
  bringIntoView('done');
}

/* ============================================================== wiring === */

el('video').addEventListener('loadeddata', () => {
  if (!pending) return;
  const v = el('video');
  v.currentTime = pending.time;
  v.playbackRate = pending.rate;
  if (pending.play) v.play().catch(() => {});
  pending = null;
});

el('play').addEventListener('click', () => (playing ? pause() : play()));

el('scrub').addEventListener('pointerdown', () => { scrubbing = true; });
el('scrub').addEventListener('pointerup', () => { scrubbing = false; });
el('scrub').addEventListener('input', () => {
  const dur = total();
  if (dur > 0) seek((num(el('scrub').value, 0) / 2000) * dur);
  followPlayhead();
});

el('split').addEventListener('click', splitHere);
/* Start again asks first, and keeps the history, so Cmd+Z brings the whole
   timeline back (walk, 2026-11-16). There are no saved projects. */
el('clear').addEventListener('click', () => {
  if (busy) return;
  el('ask-clear').returnValue = '';
  el('ask-clear').showModal();
  el('ask-clear-yes').focus();
});
el('ask-clear').addEventListener('close', () => {
  if (el('ask-clear').returnValue !== 'clear' || busy) return;
  project.clips.length = 0;
  tray.length = 0;
  afterChange();                  // writes it down for undo, then shows the start
});

function drawSettings() { el('set-ask-remove').checked = !askingIsOff(); }
el('set-ask-remove').addEventListener('change', () => {
  try {
    if (el('set-ask-remove').checked) localStorage.removeItem(NO_ASK_KEY);
    else localStorage.setItem(NO_ASK_KEY, '1');
  } catch (e) { /* it simply keeps asking */ }
});
el('mini-settings').addEventListener('toggle', drawSettings);
el('cancel').addEventListener('click', () => bridge.cancelExport());
el('go').addEventListener('click', exportNow);

async function browse() {
  if (busy) return;
  const picked = await bridge.pickVideos();
  if (picked && picked.length) addFiles(picked);
}
el('browse').addEventListener('click', browse);
el('add').addEventListener('click', browse);

/* Dropping files in, anywhere on the window (walk, 2026-11-16: the box
   was the only place that took them). A veil over the whole window says a
   drop will land. On the start screen they go onto the timeline; with the
   editor open, into the tray. dragenter and dragleave fire for every child
   crossed, so a count says when the file has really left the window. */
function carriesFiles(e) {
  return Boolean(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
}

let fileOver = 0;
function veil(on) {
  el('drop-veil').hidden = !on;
  el('drop-veil-text').textContent = el('editor').hidden ? 'Drop to start' : 'Drop to add to the tray';
  el('drop').classList.toggle('over', on && el('editor').hidden);
}
document.addEventListener('dragenter', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  fileOver += 1;
  if (!busy) veil(true);
});
document.addEventListener('dragleave', (e) => {
  if (!carriesFiles(e)) return;
  fileOver = Math.max(0, fileOver - 1);
  if (!fileOver) veil(false);
});
// Every drop is caught here, so a file can never navigate the window away.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (carriesFiles(e)) e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  fileOver = 0;
  veil(false);
  if (!carriesFiles(e) || busy) return;
  // Read the list before awaiting: the DataTransfer is emptied the moment
  // the event handler yields.
  const dropped = [...e.dataTransfer.files];
  bridge.admitDropped(dropped).then((paths) => {
    if (paths && paths.length) addFiles(paths);
  });
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (el('editor').hidden || busy || el('ask-remove').open || el('ask-clear').open || el('help-keys').open || !el('join-picker').hidden) return;
  if (e.key === 'Escape' && carry) return carry.cancel();
  if (e.key === ' ') { e.preventDefault(); return playing ? pause() : play(); }
  if (e.key === 'ArrowLeft') { pause(); seek(playhead - (e.shiftKey ? 1 : 0.1)); return followPlayhead(); }
  if (e.key === 'ArrowRight') { pause(); seek(playhead + (e.shiftKey ? 1 : 0.1)); return followPlayhead(); }
  if (e.key === 's' || e.key === 'S') return splitHere();
  if (e.key === '?') return el('help-keys').showModal();
  if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && selected >= 0) {
    e.preventDefault();
    return askRemove(selected);
  }
});

window.addEventListener('resize', () => { drawLane(); paint(); });

el('site').addEventListener('click', () => bridge.openSite());
el('licences').addEventListener('click', () => bridge.openLicences());

showEditor(false);
drawTray();
drawSettings();

})();
