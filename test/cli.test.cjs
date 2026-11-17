'use strict';

/*
 * The command line, end to end.
 *
 *   node test/cli.test.cjs
 *
 * Runs the real script as a subprocess, the way someone in a terminal would,
 * rather than calling into it, so the exit codes and the two output streams
 * are the things being checked. Tests that need real footage make it with
 * ffmpeg and skip themselves if there is none, bundled or on PATH.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.cjs');
const binaries = require('../src/binaries.cjs');
const VENDOR = [path.join(__dirname, '..', 'vendor', 'ffmpeg')];

let FFMPEG = null;
try { FFMPEG = binaries.resolve('ffmpeg', VENDOR); } catch (err) { FFMPEG = null; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-cli-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

function makeClip(name, seconds = 6) {
  const out = path.join(dir, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25`,
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac', '-pix_fmt', 'yuv420p', out]);
  return out;
}

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [CLI, ...args],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });

// What is in the folder, so a test can prove nothing appeared or changed.
const snapshot = () => fs.readdirSync(dir).sort()
  .map((f) => `${f}:${fs.statSync(path.join(dir, f)).size}`).join('|');

/* --- help --------------------------------------------------------------- */

const FLAGS = [
  '--trim', '--speed', '--transition', '--format', '--pan',
  '-o, --output', '--job', '--lossless', '--json', '--progress', '--dry-run', '--quiet', '--describe',
  '-h, --help', '-V, --version',
];

test('--help exits 0 and explains every flag', () => {
  const out = run(['--help']);
  assert.match(out, /justcut <clip>/);
  for (const flag of FLAGS) {
    assert.ok(out.includes(flag), `--help never mentions ${flag}`);
  }
  // The one promise the tool makes has to survive edits to the help text.
  assert.match(out, /nothing is\s+uploaded/i);
});

test('--help says where sound is handled instead of pretending it is not', () => {
  const out = run(['--help']);

  // Just Cut cuts audio and stops there. The help has to name the tool that
  // takes it from here, because a person reading it for a loudness flag needs
  // an answer rather than a gap.
  assert.match(out, /Just Sound/);
  assert.match(out, /justsound/);
});

// Written as escapes rather than as the characters themselves, so a sweep for
// em dashes across the tree does not keep finding the test that forbids them.
const DASHES = /[\u2014\u2013]/;

test('--help uses no em dashes, which is a house rule', () => {
  assert.doesNotMatch(run(['--help']), DASHES, 'found an em or en dash in the help text');
});

test('-V prints a version and exits 0', () => {
  assert.match(run(['-V']), /^\d+\.\d+\.\d+/);
});

/* --- --describe --------------------------------------------------------- */

// Everything below treats the JSON as a contract rather than as output. A
// script that reads it is entitled to assume these things, and the moment one
// of them stops being true somebody's pipeline breaks quietly.

const described = () => JSON.parse(run(['--describe']));

test('--describe is valid JSON on stdout and exits 0, with no clips given', () => {
  const manifest = described();
  assert.equal(manifest.schema, 'ponderdev.cli-describe/1');
  assert.equal(manifest.command, 'justcut');
  assert.equal(manifest.version, require('../package.json').version);
  assert.equal(manifest.network, false);
  assert.ok(Array.isArray(manifest.options) && manifest.options.length > 5);
});

test('--describe needs no input file and touches nothing', () => {
  const before = snapshot();
  run(['--describe']);
  assert.equal(snapshot(), before, '--describe changed something on disk');
});

test('every flag --describe lists is a flag the parser really accepts', () => {
  // The failure this catches is a table that has drifted ahead of the parser,
  // which would have a script confidently sending a flag that is refused.
  for (const opt of described().options) {
    for (const flag of opt.flags) {
      const result = spawnSync(process.execPath, [CLI, flag, 'x'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      assert.doesNotMatch(result.stderr || '', new RegExp(`Unknown option "\\${flag}"`),
        `--describe lists ${flag} but the parser does not know it`);
    }
  }
});

test('--describe and --help agree about which flags exist', () => {
  // Both are rendered from one table, so this is really asserting that the
  // table is still the only source. It is the check that stops the two from
  // ever telling a person and a script different things.
  const help = run(['--help']);
  const manifest = described();
  for (const opt of manifest.options) {
    for (const flag of opt.flags) {
      assert.ok(help.includes(flag), `--describe lists ${flag} and --help does not`);
    }
  }
  const known = new Set(manifest.options.flatMap((o) => o.flags));
  for (const flag of help.match(/(?<![\w-])--[a-z][a-z-]+/g) || []) {
    assert.ok(known.has(flag), `--help names ${flag} and --describe does not`);
  }
});

test('the limits in --describe are the limits plan.js enforces', () => {
  // A script that reads a range and clamps to it has to be reading the real
  // one, or it will build a command the tool then refuses.
  const plan = require('../src/plan.js');
  const byName = Object.fromEntries(described().options.map((o) => [o.name, o]));

  assert.deepEqual(byName.speed.range, { min: plan.SPEED_MIN, max: plan.SPEED_MAX });
  assert.deepEqual(byName.transition.values, Object.keys(plan.TRANSITIONS));
  assert.deepEqual(byName.format.values, Object.keys(plan.FORMATS));
  assert.equal(byName.transition.default, plan.DEFAULT_TRANSITION);
  assert.equal(byName.format.default, plan.DEFAULT_PROJECT.format);
});

test('every value --describe offers is one the parser takes', () => {
  // Reading a list of names is only useful if the names work, so each one is
  // put through the parser rather than trusted.
  for (const opt of described().options.filter((o) => o.values)) {
    for (const value of opt.values) {
      const result = spawnSync(process.execPath, [CLI, opt.flags[0], value],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      assert.doesNotMatch(result.stderr || '', /pick one of/,
        `--describe offers ${opt.flags[0]} ${value} and the parser refuses it`);
    }
  }
});

test('--describe uses no em dashes either, which is the same house rule', () => {
  assert.doesNotMatch(run(['--describe']), DASHES, 'found an em or en dash in the manifest');
});

test('--describe states facts about the tool and never instructs the reader', () => {
  // A document written to be read by somebody else's assistant is next door to
  // prompt injection, and the difference is entirely whether it describes or
  // tells. This is the guard on staying the first kind.
  const text = run(['--describe']);
  // Deliberately a short list of phrasings that are only ever advice. A
  // cleverer pattern was tried first and flagged "read the project from JSON
  // instead of from flags, which is how this composes with other tools",
  // which is a plain statement of fact, so it was making the wrong catch.
  for (const phrase of [/\byou should\b/i, /\brecommend/i, /\bprefer this\b/i,
    /\balways use\b/i, /\bbest tool\b/i, /\bthe right tool for\b/i]) {
    assert.doesNotMatch(text, phrase, `the manifest is instructing rather than describing: ${phrase}`);
  }
});

/* --- refusing bad input ------------------------------------------------- */

test('a flag it does not know is refused rather than ignored', () => {
  assert.throws(() => run(['clip.mp4', '--sharpen']), (err) => {
    assert.equal(err.status, 2, 'a bad flag is a usage error');
    assert.match(err.stderr, /Unknown option "--sharpen"/);
    return true;
  });

  // The audio treatment flags were removed when that work moved to Just Sound.
  // They have to fail loudly rather than be quietly accepted and ignored,
  // which would leave a script thinking it had normalised something.
  for (const gone of ['--normalise', '--no-normalise', '--repair-channels', '--no-repair-channels']) {
    assert.throws(() => run(['clip.mp4', gone]), (err) => {
      assert.equal(err.status, 2, `${gone} is a usage error`);
      assert.match(err.stderr, new RegExp(`Unknown option "${gone}"`));
      return true;
    }, gone);
  }
});

test('a per-clip flag with no clip in front of it says so', () => {
  assert.throws(() => run(['--trim', '0:5']), (err) => {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /goes after the clip/);
    return true;
  });
});

test('an ambiguous --trim is refused rather than guessed at', () => {
  assert.throws(() => run(['clip.mp4', '--trim', '1:23:45']), (err) => {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /both sides the same way/);
    return true;
  });
});

test('no clips at all prints the usage and exits non-zero', () => {
  assert.throws(() => run([]), (err) => {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /justcut <clip>/);
    return true;
  });
});

/* --- never writing over anything ---------------------------------------- */

test('it refuses to write over one of its own inputs, and writes nothing', () => {
  if (!FFMPEG) return;
  const src = makeClip('input.mp4');
  const before = fs.readFileSync(src);
  const files = snapshot();

  assert.throws(() => run([src, '-o', src]), (err) => {
    assert.equal(err.status, 2, 'overwriting an input is refused before anything starts');
    assert.match(err.stderr, /Refusing to write over/);
    return true;
  });

  assert.equal(snapshot(), files, 'something was written during a refusal');
  assert.ok(before.equals(fs.readFileSync(src)), 'the input changed');
});

test('it refuses a name that is already taken, even by a stranger', () => {
  if (!FFMPEG) return;
  const src = makeClip('taken-in.mp4');
  const taken = path.join(dir, 'taken-out.mp4');
  fs.writeFileSync(taken, 'not really a video');
  const files = snapshot();

  assert.throws(() => run([src, '-o', taken]), (err) => {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /already exists/);
    return true;
  });

  assert.equal(snapshot(), files, 'something was written during a refusal');
  assert.equal(fs.readFileSync(taken, 'utf8'), 'not really a video');
});

test('a Windows device name is refused as the output, on every platform', () => {
  if (!FFMPEG) return;
  const src = makeClip('device-in.mp4', 1);
  const files = snapshot();

  // Windows 11 writes con.mp4 and nul.mp4 as real files, older Windows writes
  // them to the device, and a script written on a Mac may run on either.
  for (const name of ['con', 'nul', 'CON.mp4', 'nul.mp4', 'Lpt1.mp4', 'com9.x.mp4', 'aux .mp4']) {
    assert.throws(() => run([src, '-o', path.join(dir, name)]), (err) => {
      assert.equal(err.status, 2, `-o ${name}`);
      assert.match(err.stderr, /is a name Windows keeps for a device, so nothing would be saved\. Choose another name\./, `-o ${name}`);
      assert.equal(err.stderr.trim().split('\n').length, 1, `-o ${name} said more than one line`);
      return true;
    });
  }
  assert.equal(snapshot(), files, 'something was written during a refusal');
});

/* --- clips that are not clips ------------------------------------------- */

test('a broken image or a still picture is named in one line, not raw ffmpeg', () => {
  if (!FFMPEG) return;
  const src = makeClip('picture-in.mp4', 1);
  // ffprobe reads this as a 0x0 JPEG, so it got past the probe and failed in
  // the export with "[out#0/mp4 @ ...] ... Conversion failed!".
  const broken = path.join(dir, 'broken.jpg');
  fs.writeFileSync(broken, 'not a jpeg!!\n');
  const still = path.join(dir, 'still.jpg');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', still]);
  const files = snapshot();

  const cases = [
    [broken, /^broken\.jpg could not be read: /],
    [still, /^still\.jpg is a picture, not a video/],
  ];
  for (const [clip, message] of cases) {
    assert.throws(() => run([src, clip, '-o', path.join(dir, 'picture-out.mp4')]), (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, message);
      assert.equal(err.stderr.trim().split('\n').length, 1, err.stderr);
      assert.doesNotMatch(err.stderr, /Conversion failed|@ 0x/);
      return true;
    });
  }
  assert.equal(snapshot(), files, 'something was written during a refusal');
});

/* --- dry run ------------------------------------------------------------ */

test('--dry-run prints a timeline and a command, and runs nothing', () => {
  if (!FFMPEG) return;
  const one = makeClip('dry-one.mp4');
  const two = makeClip('dry-two.mp4');
  const out = path.join(dir, 'dry-out.mp4');
  const files = snapshot();

  const printed = run([one, '--trim', '0:2', two, '--trim', '1:3', '--speed', '2',
    '--transition', 'fade', '--format', 'vertical', '-o', out, '--dry-run']);

  assert.match(printed, /^Timeline$/m);
  assert.ok(printed.includes('dry-one.mp4'), 'the first clip is not in the timeline');
  assert.ok(printed.includes('dry-two.mp4'), 'the second clip is not in the timeline');
  assert.match(printed, /^Command$/m);
  assert.match(printed, /ffmpeg/, 'no ffmpeg command was printed');
  assert.ok(printed.includes(out), 'the output path is not shown');

  // 2 seconds, then 2 seconds at double speed, less the half second the fade
  // overlaps them by, because a transition takes time from both sides at once.
  assert.match(printed, /2\.500s in total/);
  assert.ok(printed.includes('0:01.500'), 'the second clip should start inside the first');

  assert.equal(snapshot(), files, '--dry-run wrote something');
  assert.equal(fs.existsSync(out), false, '--dry-run created the output file');
});

test('a cut costs no time, and a fade costs half a second of it', () => {
  if (!FFMPEG) return;
  const one = makeClip('join-one.mp4');
  const two = makeClip('join-two.mp4');
  const args = (join) => [one, '--trim', '0:2', two, '--trim', '0:2',
    '--transition', join, '-o', path.join(dir, `join-${join}.mp4`), '--dry-run'];

  assert.match(run(args('cut')), /4\.000s in total/);
  assert.match(run(args('fade')), /3\.500s in total/);
});

/* --- sound is measured, said, and left alone ---------------------------- */

// A clip with the mic wired to the left and nothing at all on the right, which
// is what a lot of cameras produce. astats reports a channel like that as
// "-inf" rather than as a number, so this is also the case a reader has to
// actually match rather than one it can treat as exotic.
function makeOneSidedClip(name, seconds = 3) {
  const out = path.join(dir, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440,pan=stereo|c0=c0|c1=0*c0',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac', '-pix_fmt', 'yuv420p', out]);
  return out;
}

// The RMS of each side of a finished file, so a test can prove the export was
// left as it was rather than quietly repaired.
function channelLevels(file) {
  // astats writes to stderr on a run that succeeds, which is why this is
  // spawnSync rather than execFileSync: the latter only hands back stdout.
  const done = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af',
    'channelsplit=channel_layout=stereo[l][r];[l]astats=metadata=1:reset=0[la];' +
    '[r]astats=metadata=1:reset=0[ra];[la][ra]amix', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const text = String(done.stderr || '');
  const levels = {};
  for (const line of text.split('\n')) {
    const m = line.match(/Parsed_astats_(\d+)[^\]]*\]\s*RMS level dB:\s*(-?inf|-?[0-9.]+)/);
    if (m && levels[m[1]] === undefined) levels[m[1]] = m[2].endsWith('inf') ? -120 : Number(m[2]);
  }
  return { left: levels['1'], right: levels['2'] };
}

test('a one sided clip is named on stderr, and names the tool that fixes it', () => {
  if (!FFMPEG) return;
  const src = makeOneSidedClip('warned.mp4');
  const out = path.join(dir, 'warned-out.mp4');

  // --dry-run, because the warning is worked out from the probe and is said
  // before anything is spawned to write with, so this costs no encode.
  const child = spawnSync(process.execPath, [CLI, src, '--trim', '0:2', '-o', out, '--dry-run'],
    { encoding: 'utf8' });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /warned\.mp4/);
  assert.match(child.stderr, /only on one channel/i);
  assert.match(child.stderr, /Just Sound/);

  // A warning rather than an error, so it is said and then got on with.
  assert.match(child.stdout, /^Timeline$/m);
});

test('a one sided clip is exported exactly as one sided as it arrived',
  { timeout: 300000 }, () => {
    if (!FFMPEG) return;
    const src = makeOneSidedClip('one-sided.mp4');
    const out = path.join(dir, 'one-sided-out.mp4');

    assert.equal(run([src, '--trim', '0:2', '-o', out, '--quiet']).trim(), out);

    const before = channelLevels(src);
    const after = channelLevels(out);

    // Just Cut used to promote the live channel to both sides here. It must
    // not any more: repairing a recording is changing how it sounds, and the
    // whole point of the warning above is that the file is handed on intact
    // for Just Sound to deal with.
    assert.ok(before.left - before.right > 12, 'the fixture is not actually one sided');
    assert.ok(after.left - after.right > 12, 'the export was repaired, which it must not be');
  });

/* --- the job file ------------------------------------------------------- */

test('--job round-trips a project, describing the same edit as the flags', () => {
  if (!FFMPEG) return;
  const one = makeClip('json-one.mp4');
  const two = makeClip('json-two.mp4');
  const out = path.join(dir, 'json-out.mp4');

  const project = {
    clips: [
      { src: one, in: 0, out: 2, speed: 1, transition: 'cut' },
      { src: two, in: 1, out: 3, speed: 2, transition: 'fade' },
    ],
    format: 'vertical',
    pan: { x: 0.5, y: 0.5 },
  };
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, JSON.stringify(project, null, 2));

  const fromJson = run(['--job', file, '-o', out, '--dry-run']);
  const fromFlags = run([one, '--trim', '0:2', two, '--trim', '1:3', '--speed', '2',
    '--transition', 'fade', '--format', 'vertical', '-o', out, '--dry-run']);
  assert.equal(fromJson, fromFlags, 'the same edit described two ways came out different');

  // And the same project arriving on stdin, which is how it composes.
  const piped = run(['--job', '-', '-o', out, '--dry-run'], { input: JSON.stringify(project) });
  assert.equal(piped, fromJson);
});

test('flags given alongside --job win, so a saved project can be re-aimed', () => {
  if (!FFMPEG) return;
  const src = makeClip('aim.mp4');
  const file = path.join(dir, 'aim.json');
  fs.writeFileSync(file, JSON.stringify({
    clips: [{ src, in: 0, out: 2, speed: 1, transition: 'cut' }],
    format: 'source', pan: { x: 0.5, y: 0.5 },
  }));

  const printed = run(['--job', file, '--format', 'square',
    '-o', path.join(dir, 'aim-out.mp4'), '--dry-run']);
  assert.match(printed, /square format/);
});

test('clips as arguments and clips in a job file are not mixed', () => {
  assert.throws(() => run(['a.mp4', '--job', 'p.json']), (err) => {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /not both/);
    return true;
  });
});

/* --- the real thing ----------------------------------------------------- */

test('with no -o it writes beside the first clip, never onto it', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const src = makeClip('beside.mp4');
  const before = fs.readFileSync(src);

  const written = run([src, '--trim', '0:2', '--quiet']).trim();

  assert.equal(path.dirname(written), dir, 'it landed somewhere other than beside the clip');
  assert.notEqual(written.toLowerCase(), src.toLowerCase(), 'it wrote onto the clip');
  assert.ok(fs.existsSync(written) && fs.statSync(written).size > 0, 'nothing was written');
  assert.ok(before.equals(fs.readFileSync(src)), 'the clip changed');
});

test('it actually exports, and leaves both clips untouched', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const one = makeClip('real-one.mp4');
  const two = makeClip('real-two.mp4');
  const out = path.join(dir, 'real-out.mp4');
  const before = [fs.readFileSync(one), fs.readFileSync(two)];

  const printed = run([one, '--trim', '0:2', two, '--trim', '0:2', '-o', out, '--quiet']);

  assert.equal(printed.trim(), out, 'stdout should carry the path and nothing else');
  assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0, 'nothing was exported');
  assert.ok(before[0].equals(fs.readFileSync(one)), 'the first clip changed');
  assert.ok(before[1].equals(fs.readFileSync(two)), 'the second clip changed');
});

test('a fade after a cut exports, which needs the joins to agree on a timebase', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const one = makeClip('join-one.mp4', 3);
  const two = makeClip('join-two.mp4', 3);
  const three = makeClip('join-three.mp4', 3);
  const out = path.join(dir, 'join-out.mp4');

  // concat hands on a different timebase from a clip's own, and xfade refuses
  // two inputs that disagree, so cut-then-fade once wrote nothing at all.
  run([one, two, three, '--transition', 'fade', '-o', out, '--quiet']);

  assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0, 'nothing was exported');
});
