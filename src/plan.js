'use strict';

/*
 * Every decision Just Cut makes, and nothing else.
 *
 * Where a clip sits on the timeline, how long a transition can be, what size
 * the output frame is, and which file it is safe to write to. Pure functions
 * over plain objects: no ffmpeg, no filesystem, no Electron, no DOM.
 *
 * That purity is the point. The app it grew out of worked the timeline out
 * twice, once in the editor so it could draw a playhead and once in the render
 * engine so it could build a filter graph, and the two copies had to agree by
 * hand. When they drifted, the preview lied about the export and nobody found
 * out until the file was finished. This file is the one copy. The editor and
 * the engine both import it, so there is no second implementation left to
 * disagree with.
 *
 * It is deliberately loadable two ways, as a CommonJS module in node and as a
 * plain <script> in the renderer, which is why there are no requires anywhere
 * in it and why the export at the bottom is guarded.
 */

/*
 * Output shapes.
 *
 * `ratio` is width divided by height. `source` has none because it means
 * "leave the frame alone", and the ratio is whatever came in.
 */
const FORMATS = {
  source: { label: 'Same as the source', ratio: null },
  vertical: { label: 'Vertical (9:16)', ratio: 9 / 16 },
  square: { label: 'Square (1:1)', ratio: 1 },
  wide: { label: 'Widescreen (16:9)', ratio: 16 / 9 },
};

/*
 * How one clip joins the one before it.
 *
 * `xfade` is the name ffmpeg's xfade filter knows the effect by, and a null
 * one means there is no effect to apply: a cut is just two clips end to end.
 * Half a second is long enough to read as deliberate and short enough that it
 * fits inside almost any clip somebody bothered to trim.
 */
const TRANSITIONS = {
  cut: { label: 'Cut', xfade: null, duration: 0 },
  fade: { label: 'Fade', xfade: 'fade', duration: 0.5 },
  slide: { label: 'Slide', xfade: 'slideleft', duration: 0.5 },
};

const DEFAULT_TRANSITION = 'cut';

/*
 * What the open dialog offers, and what --describe says goes in. A filter on
 * the dialog and a statement to a script, not a gate: the probe decides, and
 * anything ffmpeg reads as moving picture is a clip whatever it is called.
 */
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'wmv', 'flv'];

/*
 * Speed limits.
 *
 * Outside the outer pair the result is not an edit any more, it is an
 * accident, usually a typo or a slider that got dragged off the end. Outside
 * the inner pair it is legitimate but the sound goes strange, so the user gets
 * told rather than stopped.
 */
const SPEED_MIN = 0.1;
const SPEED_MAX = 10;
const SPEED_COMFORTABLE_MIN = 0.25;
const SPEED_COMFORTABLE_MAX = 4;

// Probed durations are approximate, to within a frame or so. Comparing a trim
// point against one exactly would report an error on a clip trimmed to its own
// end, which is the most ordinary thing a person can do.
const DURATION_SLOP = 0.05;

/*
 * A project is a timeline and a frame, and nothing about how the sound is
 * treated. Just Cut trims, joins and retimes audio because it cannot cut a
 * video without cutting the sound, but it has no opinion on how that sound
 * comes out. Just Sound holds those settings.
 */
const DEFAULT_PROJECT = {
  clips: [],
  format: 'source',
  pan: { x: 0.5, y: 0.5 },
};

// ---------- small numeric helpers ----------

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Round down, never up. h264 refuses odd dimensions, and every even number
// here is derived from a crop that has to fit inside the source, so rounding
// up could ask for a pixel column the source does not have.
function evenDown(n) {
  return Math.max(2, 2 * Math.floor(n / 2));
}

// An offset, unlike a size, is allowed to be zero: hard against the left edge
// is a real answer, and 2 would be a quiet one pixel lie.
function evenOffset(n) {
  return Math.max(0, 2 * Math.floor(n / 2));
}

function clamp01(n) {
  return Math.min(1, Math.max(0, num(n, 0.5)));
}

// ---------- timeline ----------

/** How many seconds of the output one clip occupies. */
function clipDuration(clip) {
  if (!clip) return 0;
  const speed = num(clip.speed, 1);
  if (!(speed > 0)) return 0;
  // A clip trimmed backwards has no length rather than a negative one. It is
  // an error, validate() says so, but the timeline still has to be drawable
  // while the user is halfway through fixing it.
  return Math.max(0, (num(clip.out, 0) - num(clip.in, 0)) / speed);
}

// What the project asked for, before it is cut down to what will fit.
function requestedFade(clip) {
  if (!clip) return 0;
  const kind = TRANSITIONS[clip.transition];
  if (!kind || !kind.xfade) return 0;
  return Math.max(0, num(clip.transitionDuration, kind.duration));
}

/**
 * The overlap in seconds between a clip and the one before it.
 *
 * Capped at half of the shorter clip, because a transition consumes time from
 * both sides at once. Let it run longer and the next clip starts before the
 * previous one did, which shows up as a timeline that runs backwards and a
 * filter graph ffmpeg rejects.
 *
 * The version this was ported from also floored the result at 0.1s, which
 * quietly broke exactly that rule on any clip shorter than a fifth of a
 * second. There is no floor here: a clip too short to hold a transition gets a
 * cut, which is the honest answer.
 */
function fadeDur(clip, prevClip) {
  if (!clip || !prevClip) return 0;
  const wanted = requestedFade(clip);
  if (!(wanted > 0)) return 0;
  const room = Math.min(clipDuration(clip), clipDuration(prevClip)) / 2;
  return Math.max(0, Math.min(wanted, room));
}

/**
 * Where each clip begins on the output timeline.
 *
 * A transition is an overlap, so clip N starts before clip N-1 has finished,
 * and the timeline is shorter than the sum of its clips.
 */
function clipStarts(clips) {
  const list = Array.isArray(clips) ? clips : [];
  const starts = [];
  let at = 0;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) at += clipDuration(list[i - 1]) - fadeDur(list[i], list[i - 1]);
    starts.push(at);
  }
  return starts;
}

function totalDuration(clips) {
  const list = Array.isArray(clips) ? clips : [];
  if (!list.length) return 0;
  const starts = clipStarts(list);
  return starts[starts.length - 1] + clipDuration(list[list.length - 1]);
}

/**
 * Which clip is on screen at output time `t`, and where in its source file
 * that lands. Null past either end, so a scrubber can tell "nothing here"
 * apart from "the first frame".
 *
 * During a transition both clips are on screen at once, and this answers with
 * the incoming one. That matches what somebody dragging a playhead is looking
 * for: they are heading towards the new shot, not lingering on the old one.
 */
function locateClip(clips, t) {
  const list = Array.isArray(clips) ? clips : [];
  const at = num(t, NaN);
  if (!list.length || !Number.isFinite(at) || at < 0) return null;
  if (at > totalDuration(list)) return null;

  const starts = clipStarts(list);
  for (let i = list.length - 1; i >= 0; i--) {
    if (at >= starts[i]) {
      const speed = num(list[i].speed, 1) || 1;
      return { index: i, sourceTime: num(list[i].in, 0) + (at - starts[i]) * speed };
    }
  }
  return null;
}

// ---------- editing operations, all of them pure ----------

/**
 * Cut one clip into two at a point in its source file.
 *
 * The two halves are contiguous, so the join between them is always a cut: any
 * other answer would invent an overlap the footage never had. Returns the
 * clips unchanged if the split point is outside the trimmed range, since there
 * is no sensible two-piece answer to that.
 */
function splitAt(clips, index, sourceTime) {
  const list = Array.isArray(clips) ? clips.slice() : [];
  const clip = list[index];
  if (!clip) return list;

  const at = num(sourceTime, NaN);
  const from = num(clip.in, 0);
  const to = num(clip.out, 0);
  if (!Number.isFinite(at) || at <= from || at >= to) return list;

  list.splice(index, 1,
    { ...clip, out: at },
    { ...clip, in: at, transition: 'cut' });
  return list;
}

/**
 * Move a clip to another position.
 *
 * The transition travels with the clip, because it is a property of the clip
 * in the contract rather than of the slot. Whatever ends up first is forced
 * back to a cut: there is nothing before it to transition from, and a stray
 * fade there produces a filter graph with one input and two sides.
 */
function moveClip(clips, from, to) {
  const list = Array.isArray(clips) ? clips.slice() : [];
  if (!list.length) return list;
  const a = Math.min(Math.max(Math.trunc(num(from, -1)), 0), list.length - 1);
  const b = Math.min(Math.max(Math.trunc(num(to, -1)), 0), list.length - 1);
  if (!list[a] || a === b) return list;

  const [moved] = list.splice(a, 1);
  list.splice(b, 0, moved);
  if (list[0] && list[0].transition !== 'cut') list[0] = { ...list[0], transition: 'cut' };
  return list;
}

// ---------- the frame ----------

/*
 * The largest rectangle of a given aspect that fits inside the source.
 *
 * Everything about reframing comes back to this. Both the output size and the
 * crop window are the same rectangle asked about in different units.
 */
function fitInside(srcW, srcH, ratio) {
  const w = num(srcW, 0);
  const h = num(srcH, 0);
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  if (!(ratio > 0)) return { width: w, height: h };
  return (w / h > ratio)
    ? { width: h * ratio, height: h }
    : { width: w, height: w / ratio };
}

/**
 * The output frame for a format, given what came in.
 *
 * Sized from the crop the source can actually supply, so nothing is ever
 * upscaled. Blowing a 9:16 sliver of a 1080p clip up to 1080x1920 would make
 * the file bigger and the picture no better: the pixels are not there, and
 * anything playing it back will scale it to the screen anyway.
 */
function targetSize(format, srcWidth, srcHeight) {
  const shape = FORMATS[format] || FORMATS.source;
  let w = num(srcWidth, 0);
  let h = num(srcHeight, 0);
  // Nothing measured yet. 1080p is the safest thing to reason about until a
  // probe replaces it, and the same maths runs on it as on a real source.
  if (!(w > 0) || !(h > 0)) { w = 1920; h = 1080; }

  const fitted = fitInside(w, h, shape.ratio);
  return { width: evenDown(fitted.width), height: evenDown(fitted.height) };
}

/**
 * Which part of the source frame to keep when reframing.
 *
 * `pan` runs 0 to 1 across whichever axis has slack: 0 is hard left or top, 1
 * is hard right or bottom, 0.5 centres. The axis that has no slack ignores it.
 *
 * The offsets are pushed to even numbers as well as the size. Chroma in 4:2:0
 * is sampled in 2x2 blocks, so an odd offset makes the encoder resample color
 * that could have been copied straight across.
 */
function cropRect(srcW, srcH, outW, outH, pan) {
  const w = num(srcW, 0);
  const h = num(srcH, 0);
  const ratio = num(outW, 0) > 0 && num(outH, 0) > 0 ? num(outW, 0) / num(outH, 0) : 0;
  if (!(w > 0) || !(h > 0)) return { x: 0, y: 0, width: 0, height: 0 };

  const fitted = fitInside(w, h, ratio);
  const width = Math.min(evenDown(fitted.width), evenDown(w));
  const height = Math.min(evenDown(fitted.height), evenDown(h));

  const p = pan || {};
  const slackX = Math.max(0, w - width);
  const slackY = Math.max(0, h - height);
  const x = Math.min(evenOffset(slackX * clamp01(p.x)), evenOffset(slackX));
  const y = Math.min(evenOffset(slackY * clamp01(p.y)), evenOffset(slackY));

  return { x, y, width, height };
}

// ---------- speed ----------

/**
 * The atempo filters needed to pitch-correct audio at a given speed.
 *
 * One atempo only accepts 0.5 to 2.0, so anything further out is reached by
 * chaining several, each of which stays in range. Returns an empty list at
 * normal speed, where the whole filter can be left out of the graph.
 */
function atempoChain(speed) {
  const wanted = num(speed, 1);
  if (!(wanted > 0)) return [];
  if (Math.abs(wanted - 1) < 0.001) return [];

  const parts = [];
  let s = wanted;
  while (s > 2.0) { parts.push('atempo=2.0'); s /= 2.0; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts;
}

// ---------- validation ----------

/**
 * Everything wrong with a project, worst first by level.
 *
 * An error means the export would fail or produce nonsense. A warning means it
 * will work but not the way the numbers say, usually because something had to
 * be clamped to fit. Both are phrased for a person rather than a log.
 */
function validate(project, measurements) {
  const problems = [];
  const p = project || {};
  const clips = Array.isArray(p.clips) ? p.clips : [];
  const measured = measurements && Array.isArray(measurements.clips) ? measurements.clips : [];

  if (!clips.length) {
    problems.push({ level: 'error', message: 'There is nothing on the timeline yet.' });
    return problems;
  }

  if (p.format && !FORMATS[p.format]) {
    problems.push({ level: 'error', message: `"${p.format}" is not a shape this can export to.` });
  }

  clips.forEach((clip, i) => {
    const n = i + 1;
    const m = measured[i] || null;

    if (!clip.src) {
      problems.push({ level: 'error', message: `Clip ${n} has no file behind it.` });
    }

    const from = num(clip.in, NaN);
    const to = num(clip.out, NaN);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      problems.push({ level: 'error', message: `Clip ${n} has no trim points.` });
    } else {
      if (from < 0) {
        problems.push({ level: 'error', message: `Clip ${n} starts before the beginning of its file.` });
      }
      if (to <= from) {
        problems.push({ level: 'error', message: `Clip ${n} ends where it starts, so there is nothing in it.` });
      } else if (m && num(m.duration, 0) > 0 && to > num(m.duration, 0) + DURATION_SLOP) {
        problems.push({
          level: 'error',
          message: `Clip ${n} is trimmed to ${to.toFixed(2)}s but its file is only ${num(m.duration, 0).toFixed(2)}s long.`,
        });
      }
    }

    const speed = num(clip.speed, 1);
    if (!(speed > 0)) {
      problems.push({ level: 'error', message: `Clip ${n} has a speed of zero or less, which is not a speed.` });
    } else if (speed < SPEED_MIN || speed > SPEED_MAX) {
      problems.push({
        level: 'error',
        message: `Clip ${n} is set to ${speed}x, outside the ${SPEED_MIN}x to ${SPEED_MAX}x this can export.`,
      });
    } else if (speed < SPEED_COMFORTABLE_MIN || speed > SPEED_COMFORTABLE_MAX) {
      problems.push({
        level: 'warning',
        message: `Clip ${n} is set to ${speed}x, far enough from normal that the sound will be strange.`,
      });
    }

    const kind = clip.transition == null ? TRANSITIONS[DEFAULT_TRANSITION] : TRANSITIONS[clip.transition];
    if (!kind) {
      problems.push({ level: 'warning', message: `Clip ${n} asks for a "${clip.transition}" join, which is not one of these, so it will be a cut.` });
    } else if (i === 0 && kind.xfade) {
      problems.push({ level: 'warning', message: 'The first clip has nothing before it to blend with, so it will start on a cut.' });
    } else if (i > 0 && kind.xfade) {
      const wanted = requestedFade(clip);
      const room = Math.min(clipDuration(clip), clipDuration(clips[i - 1])) / 2;
      if (wanted > room + 1e-9) {
        problems.push({
          level: 'warning',
          message: `The ${kind.label.toLowerCase()} into clip ${n} is longer than the clips it joins, so it will be shortened to ${room.toFixed(2)}s.`,
        });
      }
    }

    /*
     * Sound recorded onto one channel only, usually a camera with the mic
     * wired to the left.
     *
     * A warning rather than something acted on, and that is the whole point.
     * Just Cut moves audio around; it does not change how it sounds, so the
     * clip comes out the way it went in. Saying so is the honest middle
     * ground between repairing it without being asked and letting somebody
     * publish a video that only plays out of one ear.
     */
    if (m && (m.channelFix === 'left' || m.channelFix === 'right')) {
      const name = baseName(clip.src) || `clip ${n}`;
      problems.push({
        level: 'warning',
        message: `The audio on ${name} is only on one channel. Just Sound can fix that.`,
      });
    }
  });

  // Mixed frame rates get resampled on the way out, which can judder. A
  // fraction of a frame apart is just 23.976 against 24 and is not worth
  // mentioning, so the bar is a whole frame.
  const rates = clips
    .map((clip, i) => (measured[i] ? num(measured[i].fps, 0) : 0))
    .filter((f) => f > 0);
  if (rates.length > 1 && Math.max(...rates) - Math.min(...rates) > 1) {
    problems.push({
      level: 'warning',
      message: `These clips run at different frame rates (${Math.min(...rates)} up to ${Math.max(...rates)}), so some will be resampled to match.`,
    });
  }

  return problems;
}

// ---------- paths, and the promise attached to them ----------

/*
 * Path handling written out by hand, because this file cannot require
 * node:path and still load in a browser. It only ever has to pull a name off
 * the end and put one back on, in either separator.
 */
function baseName(p) {
  const s = String(p == null ? '' : p);
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut < 0 ? s : s.slice(cut + 1);
}

function dirName(p) {
  const s = String(p == null ? '' : p);
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (cut < 0) return '';
  return cut === 0 ? s.slice(0, 1) : s.slice(0, cut);
}

// A leading dot is part of the name, not an extension: ".mp4" is a file called
// ".mp4" and stripping it would leave nothing to build an output name from.
function stem(name) {
  const cut = name.lastIndexOf('.');
  return cut > 0 ? name.slice(0, cut) : name;
}

function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.indexOf('\\') >= 0 && dir.indexOf('/') < 0 ? '\\' : '/';
  const trimmed = dir.replace(/[\\/]+$/, '');
  return `${trimmed}${sep}${name}`;
}

// Two paths are the same file if they differ only by separator, by a doubled
// slash, or by case. The last one is the one that bites: macOS and Windows
// both treat Clip.mp4 and clip.mp4 as one file, so a comparison that respects
// case would happily overwrite the original.
function normPath(p) {
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/(^|\/)\.\//g, '$1')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Is this name one Windows keeps for a device (CON, PRN, AUX, NUL, COM1-9,
 * LPT1-9), with or without an extension and in any case?
 *
 * Writing to one writes to the device, not a file, so the export "succeeds"
 * and the video is gone. Windows 11 lets some of them be files once they
 * carry an extension and older Windows does not, so they are refused on every
 * platform: a script written on a Mac may well be run on Windows. The same
 * helper as Just Caption's, so the tools agree. Windows ignores trailing dots
 * and spaces, so "nul. " is NUL too, and it reads the name only up to its
 * first dot with trailing spaces dropped, so "aux .mp4" is AUX as well.
 */
function isDeviceName(outPath) {
  if (typeof outPath !== 'string') return false;
  // Windows reads a name only up to its first dot and ignores spaces before
  // it, so "CON .mp4" and "con.take2.mp4" open the device as surely as "CON".
  // The same rule in every tool, so a name refused by one is refused by all.
  const head = outPath.split(/[\\/]/).pop().split('.')[0].replace(/ +$/, '');
  return /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(head);
}

/**
 * Is this path safe to write to, given everything the project reads from?
 *
 * The rule the whole app rests on is that an original is only ever read. This
 * is the cheap form of that check, exported so the engine and the CLI can each
 * assert it themselves rather than trusting that whoever built the path got it
 * right. Enforcing it in one place is enforcing it nowhere in particular.
 */
function isSafeOutput(outPath, inputPaths) {
  // Anything that is not a string is not a path, and a caller handing this a
  // number or an undefined has lost track of something. Refusing is the only
  // answer that cannot end in an overwrite.
  if (typeof outPath !== 'string') return false;
  const target = normPath(outPath);
  if (!target) return false;
  // A device is not a file at all, so nothing written there could be the
  // export the person is promised.
  if (isDeviceName(outPath)) return false;
  const inputs = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  return !inputs.some((input) => {
    const source = normPath(input);
    return source && source === target;
  });
}

/**
 * Where the export goes.
 *
 * Named after the first clip, so a person can tell what it came from, suffixed
 * so it can never be the file it came from, and numbered up until it lands on
 * a name nothing is using. `exists` is passed in rather than imported: this
 * file has no filesystem, and it lets the tests drive collisions that would
 * otherwise need real files on disk.
 *
 * Two rules, and they are not equal. Never returning an input is absolute.
 * Never returning something that already exists is honoured as far as it can
 * be, but if `exists` claims every name in the world is taken then no path
 * satisfies it, and refusing to return one at all would be worse than
 * returning a name nothing sane could be using.
 */
function outputPath(firstClipSrc, dir, ext, exists, inputPaths) {
  const src = String(firstClipSrc == null ? '' : firstClipSrc);
  const folder = dir || dirName(src);
  const suffix = String(ext == null || ext === '' ? '.mp4' : ext);
  const dotted = suffix.charAt(0) === '.' ? suffix : `.${suffix}`;
  // An unnamed source still needs somewhere to go, and "edit" is at least true.
  const base = stem(baseName(src)) || 'edit';

  const taken = (Array.isArray(inputPaths) ? inputPaths.slice() : []).concat([src]);
  const isTaken = typeof exists === 'function' ? exists : () => false;
  const free = (candidate) => isSafeOutput(candidate, taken) && !isTaken(candidate);

  for (let n = 1; n < 1000; n++) {
    // The house clash style, the same in every tool: clip-edit.mp4, then
    // clip-edit 2.mp4, never a number in brackets.
    const name = n === 1 ? `${base}-edit${dotted}` : `${base}-edit ${n}${dotted}`;
    const candidate = joinPath(folder, name);
    if (free(candidate)) return candidate;
  }

  // A thousand collisions means `exists` is not telling the truth. Fall back to
  // something no ordinary naming scheme produces, and keep the absolute rule.
  for (let n = 0; n < 1000; n++) {
    const candidate = joinPath(folder, `${base}-edit ${Date.now()}-${n}${dotted}`);
    if (isSafeOutput(candidate, taken)) return candidate;
  }
  return joinPath(folder, `${base}-edit ${Date.now()}-x${dotted}`);
}

const api = {
  FORMATS,
  TRANSITIONS,
  DEFAULT_TRANSITION,
  DEFAULT_PROJECT,
  VIDEO_EXTENSIONS,
  SPEED_MIN,
  SPEED_MAX,
  clipDuration,
  fadeDur,
  clipStarts,
  totalDuration,
  locateClip,
  splitAt,
  moveClip,
  targetSize,
  cropRect,
  atempoChain,
  validate,
  outputPath,
  isSafeOutput,
  isDeviceName,
};

// Guarded so the same file can be pulled into the renderer with a <script>
// tag, where there is no module object to assign to.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.JustCutPlan = api;
}
