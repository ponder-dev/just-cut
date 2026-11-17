#!/usr/bin/env node
'use strict';

/*
 * Just Cut on the command line.
 *
 * The decisions live in plan.js and the ffmpeg work in engine.cjs, neither of
 * which knows anything about Electron, so this is a wrapper rather than a
 * second implementation. The app and this produce identical output for
 * identical input, which is the whole reason those two modules are kept
 * Electron free.
 *
 * The result path goes to stdout so it pipes, and progress goes to stderr,
 * so the two can be told apart by a script as easily as by a person. With
 * --json, stdout carries JSON lines instead (CONTRACT.md section 4).
 */

const fs = require('node:fs');
const path = require('node:path');

const plan = require('./plan.js');
const engine = require('./engine.cjs');
const binaries = require('./binaries.cjs');

// Inside a packaged app the extras sit in the app's resources folder (as
// extraResources put them), not in vendor/. Run that way, by the tool belt or
// anyone, process.resourcesPath says where; under plain node it is undefined
// and only vendor/ is looked in.
const packaged = (name) => (process.resourcesPath ? [path.join(process.resourcesPath, name)] : []);
const VENDOR = [...packaged('ffmpeg'), path.join(__dirname, '..', 'vendor', 'ffmpeg')];
const PKG = require('../package.json');
const VERSION = PKG.version;

// mac and windows treat two names differing only by case as the same file, so
// the overwrite guard has to as well or it will wave through clip.MP4 as a
// place to write over clip.mp4.
const CASE_BLIND = process.platform === 'darwin' || process.platform === 'win32';

/*
 * A refusal before anything started: a bad flag, a bad job file, a missing
 * clip, a name it will not write to. Exit 2 (CONTRACT.md section 5). Every
 * other failure is exit 1.
 */
class UsageError extends Error {
  constructor(message, code = 'usage', input) {
    super(message);
    this.code = code;
    if (input !== undefined) this.input = input;
  }
}

/** A failure about one clip, so the JSON error line can say which. */
function failed(message, code, input) {
  return Object.assign(new Error(message), { code, input });
}

/* --- reading what plan.js offers --------------------------------------- */

// The two lists a person picks from. They are keyed objects in plan.js so the
// app can show a label with each, and the names are all the CLI needs.
const FORMATS = Object.keys(plan.FORMATS);
const TRANSITIONS = Object.keys(plan.TRANSITIONS);

/* --- parsing ----------------------------------------------------------- */

/** Seconds from "12", "1:23" or "1:02:03.5". */
function parseTime(text) {
  const parts = String(text).trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new UsageError(`"${text}" is not a time. Use seconds, mm:ss or hh:mm:ss.`);
  }
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

/*
 * "--trim start:end", where each side may itself contain colons.
 *
 * The rule that keeps it unambiguous is that both sides are written the same
 * way, so the field count is even and the middle colon is the one in the
 * middle. An open end is written by leaving that side off entirely.
 */
function parseTrim(text) {
  const value = String(text).trim();
  if (value.startsWith(':')) return { in: 0, out: parseTime(value.slice(1)) };
  if (value.endsWith(':')) return { in: parseTime(value.slice(0, -1)), out: null };

  const fields = value.split(':');
  if (fields.length < 2 || fields.length % 2 !== 0) {
    throw new UsageError(
      `--trim ${text}: write both sides the same way, so "0:10:1:30" is 10 seconds to 1m30, ` +
      'not something to guess at. Leave a side off for "from the start" or "to the end".');
  }
  const half = fields.length / 2;
  const from = parseTime(fields.slice(0, half).join(':'));
  const to = parseTime(fields.slice(half).join(':'));
  if (to <= from) throw new UsageError(`--trim ${text}: the end has to come after the start.`);
  return { in: from, out: to };
}

function parseSpeed(text) {
  const n = Number(text);
  // The bounds come from plan.js rather than from here, so the app and the
  // command line cannot drift apart on what they will accept.
  if (!Number.isFinite(n) || n < plan.SPEED_MIN || n > plan.SPEED_MAX) {
    throw new UsageError(`--speed ${text}: a number between ${plan.SPEED_MIN} and ${plan.SPEED_MAX}.`);
  }
  return n;
}

function parsePan(text) {
  const parts = String(text).split(',');
  const [x, y] = parts.map(Number);
  if (parts.length !== 2 || ![x, y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) {
    throw new UsageError(`--pan ${text}: two numbers from 0 to 1, like 0.5,0.5 for the middle.`);
  }
  return { x, y };
}

function oneOf(what, value, allowed) {
  const found = allowed.find((a) => a.toLowerCase() === String(value).toLowerCase());
  if (!found) throw new UsageError(`${what} ${value}: pick one of ${allowed.join(', ')}.`);
  return found;
}

function parseArgs(argv) {
  const parsed = {
    inputs: [], settings: {}, output: null, job: null, json: false, progress: false,
    lossless: false, dryRun: false, quiet: false, transitionForAll: null,
  };
  let clip = null;
  let positional = false;

  const addClip = (src) => {
    clip = { src, in: 0, out: null, speed: 1, transition: null };
    parsed.inputs.push(clip);
  };

  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    if (positional) { addClip(flag); continue; }
    let inline = null;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 2) {
      inline = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const value = () => {
      if (inline !== null) {
        if (inline === '') throw new UsageError(`${flag} needs a value.`);
        return inline;
      }
      if (++i >= argv.length) throw new UsageError(`${flag} needs a value.`);
      // "-o --quiet" is a forgotten value, not a file called --quiet. A value
      // that really starts with a dash can still be given as --flag=value.
      if (KNOWN_FLAGS.has(argv[i])) throw new UsageError(`${flag} needs a value, and got the option ${argv[i]}.`);
      // An empty variable in a script is a mistake, never a request for a
      // default or for a file with no name.
      if (argv[i] === '') throw new UsageError(`${flag} needs a value.`);
      return argv[i];
    };

    switch (flag) {
      // After this, everything is a clip, so a file whose name starts with a
      // dash can still be cut.
      case '--': positional = true; break;
      case '--dry-run': parsed.dryRun = true; break;
      case '--quiet': parsed.quiet = true; break;
      case '--json': parsed.json = true; break;
      case '--progress': parsed.progress = true; break;
      case '--lossless': parsed.lossless = true; break;
      case '--job': parsed.job = value(); break;
      case '-o': case '--output': {
        const out = value();
        // An MP4 is finished from the end backwards (the index goes at the
        // front once everything is known), so nothing can read it while it is
        // still being written.
        if (out === '-') {
          throw new UsageError('-o - is not something Just Cut can do: an MP4 has to be finished before anything can read it, so give -o a file name.');
        }
        parsed.output = out;
        break;
      }
      case '--format': parsed.settings.format = oneOf('--format', value(), FORMATS); break;
      case '--pan': parsed.settings.pan = parsePan(value()); break;

      case '--trim': {
        if (!clip) throw new UsageError('--trim describes a clip, so it goes after the clip it trims.');
        const t = parseTrim(value());
        clip.in = t.in;
        clip.out = t.out;
        break;
      }
      case '--speed': {
        if (!clip) throw new UsageError('--speed describes a clip, so it goes after the clip it speeds up.');
        clip.speed = parseSpeed(value());
        break;
      }
      case '--transition': {
        const name = oneOf('--transition', value(), TRANSITIONS);
        // Before any clip it is the join for the whole edit; after one it is
        // that clip's own join, which is how a single fade gets set.
        if (clip) clip.transition = name;
        else parsed.transitionForAll = name;
        break;
      }

      default:
        if (flag.startsWith('-')) throw new UsageError(`Unknown option "${flag}". Try --help.`);
        addClip(argv[i]);
    }
  }
  return parsed;
}

/* --- building the project ---------------------------------------------- */

// Stdin is read here and nowhere else, and only because --job was given "-".
function readJson(where) {
  let text;
  try {
    text = where === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(where, 'utf8');
  } catch (err) {
    throw new UsageError(`Could not read ${where === '-' ? 'stdin' : where}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${where === '-' ? 'stdin' : where} is not valid JSON: ${err.message}`);
  }
}

function buildProject(parsed) {
  const base = JSON.parse(JSON.stringify(plan.DEFAULT_PROJECT));
  const fallbackTransition = plan.DEFAULT_TRANSITION;
  let project;

  if (parsed.job !== null) {
    if (parsed.inputs.length) {
      throw new UsageError('Give clips as arguments or as --job, not both. The file already lists them.');
    }
    const read = readJson(parsed.job);
    if (!read || typeof read !== 'object' || Array.isArray(read)) {
      throw new UsageError('--job: the project is an object with a "clips" list, like {"clips": ["a.mp4"]}.');
    }
    project = { ...base, ...read };
    if (project.clips !== undefined && !Array.isArray(project.clips)) {
      throw new UsageError('--job: "clips" has to be a list.');
    }
    project.clips = (project.clips || []).map((given, k) => {
      // A bare path is the shortest form --describe promises.
      const c = typeof given === 'string' ? { src: given } : given;
      const where = `--job: clip ${k + 1}`;
      if (!c || typeof c !== 'object' || typeof c.src !== 'string' || !c.src) {
        throw new UsageError(`${where} needs "src", the path of a video.`);
      }
      // Checked here because a field of the wrong type would otherwise reach
      // ffmpeg's graph builder and come out as a JavaScript error.
      const number = (field, fallback) => {
        if (c[field] === undefined || c[field] === null) return fallback;
        const n = typeof c[field] === 'string' && c[field].trim() !== '' ? Number(c[field]) : c[field];
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          throw new UsageError(`${where}: "${field}" has to be a number${field === 'speed' ? '' : ' of seconds'}.`);
        }
        return n;
      };
      const speed = number('speed', 1);
      if (speed < plan.SPEED_MIN || speed > plan.SPEED_MAX) {
        throw new UsageError(`${where}: "speed" has to be between ${plan.SPEED_MIN} and ${plan.SPEED_MAX}.`);
      }
      return {
        ...c,
        in: number('in', 0),
        out: number('out', null),
        speed,
        transition: c.transition ? oneOf(`${where}: "transition"`, c.transition, TRANSITIONS) : fallbackTransition,
      };
    });
  } else {
    project = {
      ...base,
      clips: parsed.inputs.map((c) => ({
        ...c,
        transition: c.transition || parsed.transitionForAll || fallbackTransition,
      })),
    };
  }

  // Flags given alongside --job win, so a saved project can be re-run to a
  // different aspect or a different file without editing the file.
  if (parsed.settings.format !== undefined) project.format = parsed.settings.format;
  if (parsed.settings.pan !== undefined) project.pan = parsed.settings.pan;

  return project;
}

/* --- refusing to clobber ----------------------------------------------- */

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return CASE_BLIND ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/*
 * The third of the three places this is enforced: plan.js decides the name,
 * engine.cjs asserts before it spawns anything, and this refuses outright.
 * Three, because the footage someone spent an afternoon shooting is the one
 * thing in this app that cannot be made again.
 */
function resolveOutput(project, requested) {
  const sources = project.clips.map((c) => c.src);
  const out = path.resolve(requested
    || plan.outputPath(sources[0], null, '.mp4', fs.existsSync, sources));

  // First, because on Windows the device "exists" and the checks below would
  // say something untrue about it, or let it through with an extension.
  if (plan.isDeviceName(out)) {
    throw new UsageError(`${path.basename(out)} is a name Windows keeps for a device, so nothing would be saved. Choose another name.`);
  }

  for (const src of sources) {
    if (samePath(out, src)) {
      throw new UsageError(`Refusing to write over ${src}, which is one of the clips being read.`);
    }
  }
  if (fs.existsSync(out) && fs.statSync(out).isDirectory()) {
    throw new UsageError(`${out} is a folder. Give -o a file name, like ${path.join(requested || '.', 'cut.mp4')}.`);
  }
  if (fs.existsSync(out)) {
    throw new UsageError(`${out} already exists. Just Cut never writes over a file, so choose another name.`);
  }
  // Checked before the encode rather than left to ffmpeg, whose complaint
  // would name the hidden part file instead of the folder that is missing.
  if (!fs.existsSync(path.dirname(out))) {
    throw new UsageError(`The folder ${path.dirname(out)} does not exist.`);
  }
  // The file is always MP4 inside, so any other name would mislabel it.
  if (path.extname(out).toLowerCase() !== '.mp4') {
    throw new UsageError(`${out}: Just Cut writes MP4, so the name has to end in .mp4.`);
  }
  if (!plan.isSafeOutput(out, sources)) {
    throw new UsageError(`${out} is not a safe place to write.`);
  }
  return out;
}

/* --- output ------------------------------------------------------------ */

function clock(seconds) {
  const mins = Math.floor(seconds / 60);
  return `${mins}:${(seconds - mins * 60).toFixed(3).padStart(6, '0')}`;
}

// Good enough to paste back into a shell, which is the only thing --dry-run
// is for. Anything with a space or a quote in it gets wrapped.
function shellQuote(arg) {
  const text = String(arg);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function dryRun(project, measurements, opts, ffmpeg) {
  // buildRender stops short of the destination on purpose, because it is pure
  // and the real render writes to a temp file beside the destination first.
  // Adding it back here shows the command someone could actually paste.
  const { args, totalDur } = engine.buildRender(project, measurements, opts);
  const starts = plan.clipStarts(project.clips);
  const width = Math.max(...project.clips.map((c) => path.basename(c.src).length));

  const lines = ['Timeline'];
  project.clips.forEach((clip, i) => {
    const length = plan.clipDuration(clip);
    lines.push(
      `  ${String(i + 1).padStart(2)}  ${path.basename(clip.src).padEnd(width)}` +
      `  ${clock(starts[i])} to ${clock(starts[i] + length)}` +
      `  ${length.toFixed(3)}s  speed ${clip.speed}  ${clip.transition}`);
  });
  lines.push(`  ${totalDur.toFixed(3)}s in total, ${project.format} format, pan ${project.pan.x},${project.pan.y}`
    + (opts.lossless ? ', lossless' : ''));
  lines.push('', 'Output', `  ${opts.out}`);
  lines.push('', 'Command', `  ${[ffmpeg, ...args, opts.out].map(shellQuote).join(' ')}`);
  // Said out loud, because the command above is a fair copy rather than a
  // transcript: a real export encodes to a hidden file in the same folder and
  // renames it at the end, so a run that is interrupted leaves no half video
  // sitting there looking finished.
  lines.push('', 'The real run writes to a temporary file beside that and renames it when it', 'finishes, so an export that is interrupted leaves nothing behind.', '');
  return lines.join('\n');
}

/* --- the option table --------------------------------------------------- */

/*
 * One list, read twice: --help renders it for a person, --describe prints it
 * as JSON for a script. The two cannot disagree about what this accepts,
 * because there is only one place saying so.
 *
 * Anything with a limit in it points at plan.js rather than repeating the
 * number, so the bounds a script reads out of --describe are the bounds the
 * app itself enforces.
 *
 * `scope` is the thing people get wrong most often. --trim and --speed
 * describe the clip they follow; --format and --pan describe the whole edit.
 * Saying so as data means a script does not have to infer it from prose.
 */
const OPTIONS = [
  {
    flags: ['--trim'],
    metavar: 'start:end',
    section: 'Clips',
    scope: 'clip',
    type: 'timespan',
    repeatable: true,
    help: 'the part to keep. Each side is seconds, mm:ss or hh:mm:ss, and both sides '
      + 'are written the same way so the colon in the middle is never ambiguous. Leave '
      + 'a side off for "from the start" or "to the end": ":30" is the first 30 seconds, '
      + '"1:00:" is from one minute onwards.',
  },
  {
    flags: ['--speed'],
    metavar: 'n',
    section: 'Clips',
    scope: 'clip',
    type: 'number',
    range: { min: plan.SPEED_MIN, max: plan.SPEED_MAX },
    default: 1,
    repeatable: true,
    help: `playback speed from ${plan.SPEED_MIN} to ${plan.SPEED_MAX}. 1 leaves it alone.`,
  },
  {
    flags: ['--transition'],
    metavar: 'name',
    section: 'Clips',
    scope: 'clip or whole edit',
    type: 'enum',
    values: TRANSITIONS,
    default: plan.DEFAULT_TRANSITION,
    repeatable: true,
    help: 'how this clip joins the one before it. Given before any clip it sets the '
      + 'join for the whole edit.',
  },
  {
    flags: ['--format'],
    metavar: 'name',
    section: 'Whole edit',
    scope: 'whole edit',
    type: 'enum',
    values: FORMATS,
    default: plan.DEFAULT_PROJECT.format,
    help: 'what shape to finish in.',
  },
  {
    flags: ['--pan'],
    metavar: 'x,y',
    section: 'Whole edit',
    scope: 'whole edit',
    type: 'point',
    range: { min: 0, max: 1 },
    default: `${plan.DEFAULT_PROJECT.pan.x},${plan.DEFAULT_PROJECT.pan.y}`,
    help: 'where to sit the picture when reframing crops it, 0 to 1 on each axis. '
      + `Default ${plan.DEFAULT_PROJECT.pan.x},${plan.DEFAULT_PROJECT.pan.y}, the middle.`,
  },
  {
    flags: ['-o', '--output'],
    metavar: 'path',
    section: 'Output',
    scope: 'whole edit',
    type: 'path',
    default: null,
    help: 'where to write, a name ending in .mp4. Defaults to name-edit.mp4 beside the '
      + 'first clip, then name-edit 2.mp4 and so on. Never a clip, and never a file that '
      + 'is already there: it refuses instead of overwriting. Not "-": an MP4 cannot be '
      + 'read before it is finished.',
  },
  {
    flags: ['--job'],
    metavar: 'path|-',
    section: 'Whole edit',
    scope: 'whole edit',
    type: 'path',
    help: 'read the whole edit from a project file instead of from flags, "-" for '
      + 'standard input, which is the only time standard input is read. Flags given as '
      + 'well win, so a saved project can be re-run to another shape.',
  },
  {
    flags: ['--lossless'],
    section: 'Output',
    scope: 'whole edit',
    type: 'boolean',
    default: false,
    help: 'write a lossless intermediate instead of a file to send: the same MP4, with '
      + 'H.264 at -qp 0 and ALAC sound. Often ten times the size, and not every player '
      + 'opens it. For a step in the middle of a chain of tools.',
  },
  {
    flags: ['--json'],
    section: 'Output',
    scope: 'whole edit',
    type: 'boolean',
    default: false,
    help: 'results as JSON lines on stdout instead of the bare path: a result line, '
      + 'or an error line, then a done line.',
  },
  {
    flags: ['--progress'],
    section: 'Output',
    scope: 'whole edit',
    type: 'boolean',
    default: false,
    help: 'with --json, progress as JSON lines on stderr.',
  },
  {
    flags: ['--dry-run'],
    section: 'Output',
    scope: 'whole edit',
    type: 'boolean',
    default: false,
    help: 'print the timeline and the ffmpeg command it would run, and then run nothing '
      + 'at all. The clips are still read, to measure them. With --json the plan is '
      + 'the result line.',
  },
  {
    flags: ['--quiet'],
    section: 'Output',
    scope: 'whole edit',
    type: 'boolean',
    default: false,
    help: 'nothing on stderr but errors: no progress, no notes about the clips and no '
      + 'closing line.',
  },
  {
    flags: ['--describe'],
    section: 'Output',
    scope: 'whole edit',
    type: 'boolean',
    default: false,
    help: 'print these options as JSON, with their types, defaults and ranges, and then '
      + 'do nothing else. For a script, or an assistant, that would otherwise be '
      + 'guessing at flags.',
  },
  {
    flags: ['-h', '--help'],
    section: 'Output',
    scope: 'whole edit',
    type: 'boolean',
    default: false,
    help: 'this.',
  },
  {
    flags: ['-V', '--version'],
    section: 'Output',
    scope: 'whole edit',
    type: 'boolean',
    default: false,
    help: 'version.',
  },
];

// Every flag the table knows, so a missing value is not mistaken for a flag
// being passed in its place.
const KNOWN_FLAGS = new Set(OPTIONS.flatMap((o) => o.flags));

// Where the description starts, and where a line ends. Both are only about how
// --help looks, and neither reaches --describe.
const GUTTER = 24;
const WIDTH = 78;

function wrapText(text, width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** The rows of one --help section, rendered from the table above. */
function helpRows(section) {
  const pad = ' '.repeat(GUTTER);
  const out = [];

  for (const opt of OPTIONS.filter((o) => o.section === section)) {
    const left = opt.flags.join(', ') + (opt.metavar ? ` <${opt.metavar}>` : '');
    const body = wrapText(opt.help, WIDTH - GUTTER);
    // On its own line, because a list of names reads better whole than wrapped
    // into the middle of a sentence.
    if (opt.values) body.push(`One of: ${opt.values.join(', ') || 'see plan.js'}`);

    // A flag too long for the gutter starts its description on the next line
    // rather than shoving one paragraph out of line with all the others.
    if (left.length > GUTTER - 3) {
      out.push(`  ${left}`, ...body.map((l) => pad + l));
    } else {
      out.push(`  ${left.padEnd(GUTTER - 2)}${body[0]}`, ...body.slice(1).map((l) => pad + l));
    }
  }
  return out.join('\n');
}

// Every code this can return, with --describe reading the same list.
const EXIT = [
  { code: 0, meaning: 'Done. --help, --version, --describe and --dry-run also exit 0, having written no file.' },
  { code: 1, meaning: 'Failed: a clip that is not a video, no ffmpeg, or an encode that went wrong. Nothing usable was written.' },
  { code: 2, meaning: 'Usage: a bad option or value, a bad job file, no clips, a missing clip, an edit that does not fit its clips, or an output name it will not write to. Nothing was started.' },
  { code: 129, meaning: 'Stopped by a hang-up. The encoder is stopped and its part file deleted.' },
  { code: 130, meaning: 'Stopped with Ctrl-C. The encoder is stopped and its part file deleted.' },
  { code: 143, meaning: 'Stopped by a terminate signal. The encoder is stopped and its part file deleted.' },
];

/*
 * --describe.
 *
 * Facts about what this accepts and what it does, never advice about when to
 * reach for it. A document written to be read by somebody else's assistant is
 * uncomfortably close to prompt injection, and the whole difference is whether
 * it states things or tells that assistant what to do.
 */
function describe() {
  return {
    schema: 'ponderdev.cli-describe/1',
    name: PKG.name,
    product: PKG.productName,
    version: VERSION,
    licence: PKG.license,
    command: 'justcut',
    job: 'Cut a video down and put the pieces in order.',
    network: false,
    accepts: {
      mediaTypes: ['video/*'],
      extensions: plan.VIDEO_EXTENSIONS.map((e) => `.${e}`),
    },
    emits: { mediaTypes: ['video/mp4'], extensions: ['.mp4'] },
    arguments: [{
      name: 'clip',
      type: 'path',
      required: true,
      repeatable: true,
      help: 'a video file. Clips are joined in the order they are named, and any clip '
        + 'option written after a clip describes that clip. Whether a file is a clip is '
        + 'decided by reading it, not by its name: anything ffmpeg reads as moving '
        + 'picture is one, and a still picture is refused.',
    }],
    options: OPTIONS.map((opt) => ({
      flags: opt.flags,
      name: opt.flags[opt.flags.length - 1].replace(/^--/, ''),
      metavar: opt.metavar || null,
      section: opt.section,
      scope: opt.scope,
      type: opt.type,
      repeatable: Boolean(opt.repeatable),
      ...(opt.values ? { values: opt.values } : {}),
      ...(opt.range ? { range: opt.range } : {}),
      ...(opt.default !== undefined ? { default: opt.default } : {}),
      help: opt.help,
    })),
    jobFile: {
      help: 'what --job reads, and the same shape the window builds. Every field except '
        + 'src has a default, so the shortest useful project is a list of paths.',
      example: {
        clips: [{ src: 'a.mp4', in: 0, out: 12, speed: 1, transition: 'fade' }],
        format: 'vertical',
        pan: { x: 0.5, y: 0.5 },
      },
    },
    output: {
      video: 'name-edit.mp4 beside the first clip, H.264 and AAC',
      taken: 'name-edit 2.mp4, then 3, never over an existing file',
      size: 'the first clip\'s picture, upright, cropped to the format\'s shape and never '
        + 'scaled up; later clips are scaled and cropped to match it. The frame rate is '
        + 'the highest among the clips.',
      lossless: 'with --lossless, the same MP4 with H.264 at -qp 0 and ALAC sound',
    },
    result: {
      fields: {
        input: 'path', inputs: 'path[]', output: 'path', bytes: 'integer',
        duration: 'number', width: 'integer', height: 'integer', fps: 'number',
        format: 'string', lossless: 'boolean', clips: 'integer', notes: 'string[]',
      },
    },
    // The desktop app carries ffmpeg; the npm command line uses the one on the
    // PATH, and says how to install it if there is none.
    needs: [
      { id: 'ffmpeg', kind: 'binary', bundled: 'in the desktop app; the npm install uses ffmpeg from the PATH' },
      { id: 'ffprobe', kind: 'binary', bundled: 'in the desktop app; the npm install uses ffprobe from the PATH' },
    ],
    io: {
      stdin: 'the project, as JSON, when --job is given "-". Never read otherwise.',
      stdout: 'the path of the file it wrote, on one line, so it pipes into whatever '
        + 'comes next. --dry-run prints the timeline and the ffmpeg command instead. '
        + 'With --json, JSON lines and nothing else.',
      stderr: 'progress, notes and errors for people, so a script can tell them from the '
        + 'result. With --json and --progress, progress as JSON lines.',
    },
    exitCodes: EXIT,
    guarantees: [
      'Clips are only ever read.',
      'It refuses to write over any file that already exists, including a clip.',
      'It writes to a temporary name beside the output and renames it at the end, so a stopped run leaves nothing behind.',
      'It makes no network connection of any kind.',
      'The same clips and the same flags give the same output, so a run is repeatable.',
    ],
  };
}

function usage() {
  return `Just Cut ${VERSION}
Cut a video down and put the pieces in order.

  justcut <clip> [options]
  justcut <clip> [clip options] <clip> [clip options] ... [options]
  justcut --job project.json -o cut.mp4
  cat project.json | justcut --job - --dry-run

Clips
  Clips are joined in the order you name them. --trim, --speed and
  --transition describe the clip they follow, so each clip is set up right
  after it is named.

${helpRows('Clips')}

Whole edit
${helpRows('Whole edit')}

Sound
  There are no sound options, and that is on purpose. This cuts audio, it
  does not treat it. Clips are trimmed, retimed, joined and crossfaded,
  because there is no cutting a video without cutting the sound under it, and
  a clip with no audio track gets silence so the rest does not play mute.
  Nothing here changes how the result sounds: the levels come out the way
  they were recorded.

  Evening out loudness, and rescuing a clip recorded onto one channel only,
  belong to Just Sound. It takes a video and gives back a video, same as this
  one, so the two chain:

    justsound "$(justcut clip.mp4 --trim 0:30 --quiet)"

  A clip that is only on one channel is still noticed, and said on stderr
  unless --quiet, and then left exactly as it was.

Output
${helpRows('Output')}

The --job file is the same object the app uses:
  { "clips": [ { "src": "a.mp4", "in": 0, "out": 12, "speed": 1,
                 "transition": "fade" } ],
    "format": "vertical", "pan": { "x": 0.5, "y": 0.5 } }

Exit status: 0 done, 1 failed, 2 usage (nothing was started), 129, 130 or 143
stopped by a signal, with the part file deleted.

Your clips are only ever read. Nothing is written over, and nothing is
uploaded: this makes no network connection of any kind.`;
}

/* --- reporting --------------------------------------------------------- */

/*
 * JSON lines (CONTRACT.md section 4): a result line or an error line, then a
 * done line, always. Off unless --json, and then stdout carries nothing else.
 * Just Cut writes one file per run, so there is never more than one result.
 */
const report = {
  on: false,
  counts: { results: 0, skipped: 0, failed: 0 },
  line(obj) { if (this.on) process.stdout.write(JSON.stringify(obj) + '\n'); },
  result(obj) { this.counts.results++; this.line({ type: 'result', ...obj }); },
  error(code, message, input) {
    this.counts.failed++;
    this.line({ type: 'error', ok: false, code, message, ...(input !== undefined ? { input } : {}) });
  },
  done(exit) { this.line({ type: 'done', ok: exit === 0, ...this.counts, exit }); },
};

/* --- stopping ---------------------------------------------------------- */

/*
 * Ctrl-C, a hang-up or a supervisor's SIGTERM. Before the encode there is
 * nothing to clean up, so it exits on the spot. During it, the encoder has to
 * be stopped rather than orphaned, and the engine's control handle is the only
 * thing that knows which child to kill, so the exit waits for render to fail
 * with "Cancelled", because that is where the part file gets deleted. A second
 * signal does not wait.
 */
const stopping = { ctl: null, code: null };
const SIGNALS = [['SIGINT', 130], ['SIGTERM', 143]];
if (process.platform !== 'win32') SIGNALS.push(['SIGHUP', 129]);

function listenForSignals() {
  for (const [sig, code] of SIGNALS) {
    process.on(sig, () => {
      if (stopping.code !== null || !stopping.ctl) {
        process.stderr.write('Stopped. Nothing was written.\n');
        report.error('stopped', 'Stopped. Nothing was written.');
        report.done(stopping.code ?? code);
        process.exit(stopping.code ?? code);
      }
      stopping.code = code;
      stopping.ctl.cancel();
    });
  }
}

/* --- doing it ---------------------------------------------------------- */

function stat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

async function main(argv) {
  // Answered before anything else is looked at: a bad option beside them
  // still gets an answer, no file is opened and stdin is never read.
  if (argv.includes('-h') || argv.includes('--help')) { process.stdout.write(usage() + '\n'); return 0; }
  if (argv.includes('-V') || argv.includes('--version')) { process.stdout.write(VERSION + '\n'); return 0; }
  if (argv.includes('--describe')) { process.stdout.write(JSON.stringify(describe(), null, 2) + '\n'); return 0; }

  report.on = argv.includes('--json');
  listenForSignals();
  const parsed = parseArgs(argv);
  const say = (text) => { if (!parsed.quiet) process.stderr.write(text); };

  const project = buildProject(parsed);
  if (!project.clips.length) {
    throw new UsageError('Nothing to cut. Name a clip, as in: justcut <clip> [options], or see --help.');
  }
  for (const clip of project.clips) {
    const found = stat(clip.src);
    if (!found) throw new UsageError(`No such file: ${clip.src}`, 'usage', clip.src);
    if (found.isDirectory()) throw new UsageError(`${clip.src} is a folder, not a video.`, 'usage', clip.src);
  }

  // Before anything is probed or spawned, because a refusal should cost
  // nothing and arrive immediately.
  const out = resolveOutput(project, parsed.output);

  let ffprobe;
  let ffmpeg;
  try {
    ffprobe = binaries.resolve('ffprobe', VENDOR);
    ffmpeg = binaries.resolve('ffmpeg', VENDOR);
  } catch (err) {
    throw failed(err.message, 'no-ffmpeg');
  }

  // One clip at a time, so the error can say which clip is not a video. Both
  // binaries, not just ffprobe: noticing that a clip was recorded onto one
  // channel only means running a filter graph, which ffprobe cannot do.
  const measurements = { clips: [] };
  for (const clip of project.clips) {
    try {
      const { clips: [m] } = await engine.probe({ ffprobe, ffmpeg }, [clip.src]);
      measurements.clips.push(m);
    } catch (err) {
      throw failed(String(err && err.message ? err.message : err), 'not-a-video', path.resolve(clip.src));
    }
  }

  // An end left open by "--trim 1:00:" is only knowable once the clip has
  // been measured, so it is filled in here rather than guessed at earlier.
  project.clips.forEach((clip, i) => {
    if (clip.out === null || clip.out === undefined) clip.out = measurements.clips[i].duration;
  });

  // Warnings are things that will still export, just not the way the numbers
  // read, so they are said out loud and then got on with. Errors stop it.
  const problems = plan.validate(project, measurements);
  const errors = problems.filter((p) => p.level === 'error');
  if (errors.length) throw new UsageError(errors.map((p) => p.message).join('\n'), 'bad-edit');
  const notes = problems.filter((p) => p.level !== 'error').map((p) => p.message);
  for (const note of notes) say(`Note: ${note}\n`);

  const first = measurements.clips[0];
  const frame = plan.targetSize(project.format, first.width, first.height);
  const facts = {
    input: path.resolve(project.clips[0].src),
    inputs: project.clips.map((c) => path.resolve(c.src)),
    output: out,
    duration: Number(plan.totalDuration(project.clips).toFixed(3)),
    width: frame.width,
    height: frame.height,
    fps: engine.targetFps(measurements),
    format: project.format,
    lossless: parsed.lossless,
    clips: project.clips.length,
    notes,
  };
  const opts = { out, lossless: parsed.lossless };

  if (parsed.dryRun) {
    if (report.on) {
      const { args } = engine.buildRender(project, measurements, opts);
      const starts = plan.clipStarts(project.clips);
      report.result({
        ok: true,
        dryRun: true,
        ...facts,
        timeline: project.clips.map((c, i) => ({
          src: path.resolve(c.src), in: c.in, out: c.out, speed: c.speed, transition: c.transition,
          start: Number(starts[i].toFixed(3)), length: Number(plan.clipDuration(c).toFixed(3)),
        })),
        command: [ffmpeg, ...args, out],
      });
    } else {
      process.stdout.write(dryRun(project, measurements, opts, ffmpeg));
    }
    return 0;
  }

  let shown = '';
  const onProgress = ({ stage, progress }) => {
    if (report.on) {
      if (parsed.progress && stage !== 'Done') {
        process.stderr.write(JSON.stringify({ type: 'progress', stage: 'encode', percent: Math.round(progress * 100) }) + '\n');
      }
      return;
    }
    if (parsed.quiet || !process.stderr.isTTY) return;
    const line = `\r${stage} ${Math.round(progress * 100)}%   `;
    if (line !== shown) { process.stderr.write(line); shown = line; }
  };

  const ctl = engine.control();
  stopping.ctl = ctl;
  try {
    await engine.render(ffmpeg, project, measurements, { ...opts, ctl }, onProgress);
  } catch (err) {
    if (stopping.code !== null) {
      if (shown) process.stderr.write('\r\x1b[K');
      process.stderr.write('Stopped. Nothing was written.\n');
      report.error('stopped', 'Stopped. Nothing was written.');
      return stopping.code;
    }
    throw failed(String(err && err.message ? err.message : err), 'encode-failed');
  } finally {
    stopping.ctl = null;
  }
  if (shown) process.stderr.write('\r\x1b[K');

  report.result({ ok: true, ...facts, bytes: fs.statSync(out).size });
  if (!report.on) {
    say(`Wrote ${out}\n`);
    // The path on stdout, so this can be piped into whatever comes next.
    process.stdout.write(out + '\n');
  }
  return 0;
}

// Waits until everything written to stdout has been handed to the OS, so
// exiting straight after cannot cut off the last JSON line.
function drainStdout() {
  return new Promise((resolve) => process.stdout.write('', () => resolve()));
}

// A reader that stops early (`| head`) is not an error worth a stack trace.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  process.stderr.write(String(err.message || err) + '\n');
  process.exit(1);
});

module.exports = { describe, usage, OPTIONS, EXIT };

if (require.main === module) {
  main(process.argv.slice(2))
    .then(async (code) => { report.done(code); await drainStdout(); process.exit(code); })
    .catch(async (err) => {
      const usageError = err instanceof UsageError;
      const code = usageError ? 2 : 1;
      const message = String(err && err.message ? err.message : err);
      report.error(err.code || (usageError ? 'usage' : 'failed'), message, err.input);
      process.stderr.write(message + '\n');
      report.done(code);
      await drainStdout();
      process.exit(code);
    });
}
