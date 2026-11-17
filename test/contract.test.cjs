'use strict';

/*
 * The command-line contract (CONTRACT.md in the PonderDev tools workshop):
 * what every Just tool promises so a script, an assistant or the tool belt can
 * drive it without guessing.
 *
 *   node test/contract.test.cjs
 *
 * The parts that need footage make it with ffmpeg and skip themselves when
 * there is none, bundled or on PATH.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.cjs');
const binaries = require('../src/binaries.cjs');
const VENDOR = [path.join(__dirname, '..', 'vendor', 'ffmpeg')];
let FFMPEG;
let FFPROBE;
try {
  FFMPEG = binaries.resolve('ffmpeg', VENDOR);
  FFPROBE = binaries.resolve('ffprobe', VENDOR);
} catch (e) { FFMPEG = null; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-contract-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const jsonLines = (text) => String(text || '').split('\n').flatMap((l) => {
  try { const o = JSON.parse(l); return o && o.type ? [o] : []; } catch (e) { return []; }
});

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir, timeout: 120000, ...opts });
  return { ...r, lines: jsonLines(r.stdout) };
}

function makeClip(name, { seconds = 2, size = '320x240', audio = true } = {}) {
  const out = path.join(dir, name);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`,
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440'] : []),
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    ...(audio ? ['-c:a', 'aac'] : []), out]);
  return out;
}

// Anything left in the folder by an export: a finished file or a part file.
const leftovers = (prefix) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix) || f.startsWith('.justcut-'));

test('--help, --version and --describe answer first and do no work', () => {
  for (const flag of ['--help', '-h', '--version', '-V', '--describe']) {
    const before = fs.readdirSync(dir).length;
    // A bad option, a missing file and an open stdin pipe that never closes:
    // none of them may get in the way, and stdin must not be waited on.
    const r = spawnSync(process.execPath, [CLI, '--no-such-option', 'missing.mp4', '--job', '-', flag],
      { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(r.status, 0, `${flag}: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, `${flag} printed nothing`);
    assert.equal(fs.readdirSync(dir).length, before, `${flag} wrote nothing`);
  }
});

test('stdin is never read unless asked for with "-"', () => {
  // An open pipe that never sends anything, which is what a harness or a CI
  // job looks like. No clips named is a usage error, at once.
  const r = spawnSync(process.execPath, [CLI, '--json'], { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(jsonLines(r.stdout).at(-1).exit, 2);
});

test('--describe is the shared schema and matches --help', () => {
  const d = JSON.parse(run(['--describe']).stdout);
  assert.equal(d.schema, 'ponderdev.cli-describe/1');
  assert.equal(d.name, 'justcut');
  assert.equal(d.command, 'justcut');
  assert.equal(d.network, false);
  assert.equal(d.licence, 'GPL-3.0-or-later');
  assert.ok(d.accepts.mediaTypes.includes('video/*'));
  assert.ok(d.accepts.extensions.includes('.mp4') && d.accepts.extensions.includes('.mov'));
  assert.ok(d.accepts.extensions.every((e) => e.startsWith('.')));
  assert.deepEqual(d.emits.extensions, ['.mp4']);
  assert.ok(d.jobFile && d.jobFile.example && Array.isArray(d.jobFile.example.clips), 'jobFile');
  assert.equal(d.projectJson, undefined, 'projectJson became jobFile');
  for (const f of ['input', 'output', 'bytes', 'width', 'height', 'duration']) {
    assert.ok(d.result.fields[f], `result.fields.${f}`);
  }
  assert.ok(d.needs.some((n) => n.id === 'ffmpeg' && n.kind === 'binary' && n.bundled));
  assert.ok(Array.isArray(d.guarantees) && d.guarantees.length > 0);
  assert.deepEqual(d.exitCodes.map((e) => e.code), [0, 1, 2, 129, 130, 143]);

  const help = run(['--help']).stdout;
  for (const o of d.options) for (const f of o.flags) assert.ok(help.includes(f), `--help lists ${f}`);
  assert.match(help, /justcut <clip> \[options\]/, 'usage reads tool <file> [options]');

  // The shared flags, each with one meaning.
  const flags = new Set(d.options.flatMap((o) => o.flags));
  for (const f of ['-h', '--help', '--version', '--describe', '--json', '--job', '--dry-run', '-o', '--output', '--quiet', '--progress', '--lossless']) {
    assert.ok(flags.has(f), `${f} is in the table`);
  }
  assert.equal(flags.has('-q'), false, '-q stays unused');
  assert.equal(flags.has('--overwrite'), false, 'Just Cut never replaces a file, so it has no --overwrite');
});

test('usage errors exit 2, as JSON under --json, with the sentence on stderr and a done line', () => {
  const job = path.join(dir, 'broken.json');
  fs.writeFileSync(job, '{ not json');
  for (const args of [
    ['--bogus'], ['-q'], [], ['missing.mp4'], ['x.mp4', '-o', '-'], ['x.mp4', '--speed', '99'],
    ['x.mp4', '--format', 'round'], ['--trim', '0:5'], ['x.mp4', '-o'], ['--job', job],
    ['--job', 'missing.json'], ['a.mp4', '--job', job], ['x.mp4', '--overwrite'],
  ]) {
    const r = run([...args, '--json']);
    const label = args.join(' ') || '(nothing)';
    assert.equal(r.status, 2, label);
    assert.equal(r.lines.length, 2, `${label}: one error line and one done line`);
    assert.equal(r.lines[0].type, 'error');
    assert.equal(r.lines[0].ok, false);
    assert.equal(r.lines[0].code, 'usage');
    assert.ok(r.stderr.includes(r.lines[0].message), `${label}: the sentence is on stderr too`);
    assert.deepEqual(r.lines[1], { type: 'done', ok: false, results: 0, skipped: 0, failed: 1, exit: 2 });
  }
});

test('without --json, stdout stays empty on an error', () => {
  const r = run(['--bogus']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Unknown option "--bogus"/);
});

test('a result line, a done line, and the house output name and clash style', { skip: !FFMPEG, timeout: 300000 }, () => {
  const clip = makeClip('named.mp4');
  const first = run([clip, '--json']);
  assert.equal(first.status, 0, first.stderr);
  const [result, done] = first.lines;
  assert.equal(result.type, 'result');
  assert.equal(result.ok, true);
  assert.equal(result.input, clip);
  assert.equal(result.output, path.join(dir, 'named-edit.mp4'));
  assert.equal(result.bytes, fs.statSync(result.output).size);
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
  assert.deepEqual(done, { type: 'done', ok: true, results: 1, skipped: 0, failed: 0, exit: 0 });
  // stdout carried JSON and nothing else: no bare path.
  assert.equal(first.stdout.trim().split('\n').length, 2);

  const second = run([clip, '--json']);
  assert.equal(second.lines[0].output, path.join(dir, 'named-edit 2.mp4'), 'name-edit 2.mp4, never (2)');
});

test('a file that is not a video is exit 1, named, as JSON', { skip: !FFMPEG }, () => {
  const text = path.join(dir, 'notes.mp4');
  fs.writeFileSync(text, 'this is not a video\n');
  const r = run([text, '--json']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.lines[0].type, 'error');
  assert.equal(r.lines[0].code, 'not-a-video');
  assert.equal(r.lines[0].input, text);
  assert.match(r.lines[0].message, /^notes\.mp4 could not be read/);
  assert.equal(r.lines.at(-1).exit, 1);
  assert.deepEqual(leftovers('notes-edit'), []);
});

test('--dry-run --json writes nothing and the plan is the result', { skip: !FFMPEG }, () => {
  const clip = makeClip('dry.mp4');
  const before = fs.readdirSync(dir).sort();
  const r = run([clip, '--trim', '0:1', '--format', 'square', '--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const [result, done] = r.lines;
  assert.equal(result.dryRun, true);
  assert.equal(result.output, path.join(dir, 'dry-edit.mp4'));
  assert.equal(result.duration, 1);
  assert.equal(result.width, 240);
  assert.equal(result.height, 240);
  assert.equal(result.timeline.length, 1);
  assert.equal(result.command.at(-1), result.output);
  assert.equal(done.exit, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('--lossless writes H.264 at -qp 0 with ALAC sound, still an MP4', { skip: !FFMPEG, timeout: 300000 }, () => {
  const clip = makeClip('pristine.mp4');
  const r = run([clip, '--lossless', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.lines[0].output;
  assert.equal(r.lines[0].lossless, true);
  assert.match(out, /pristine-edit\.mp4$/);
  const streams = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,profile,pix_fmt', '-of', 'json', out], { encoding: 'utf8' });
  const [video, audio] = JSON.parse(streams).streams;
  assert.equal(video.codec_name, 'h264');
  assert.match(video.profile, /4:4:4 Predictive/, 'x264 says lossless with this profile');
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.equal(audio.codec_name, 'alac');
});

test('--progress puts JSON progress lines on stderr', { skip: !FFMPEG, timeout: 300000 }, () => {
  const clip = makeClip('busy.mp4', { seconds: 3 });
  const r = run([clip, '--json', '--progress']);
  assert.equal(r.status, 0, r.stderr);
  const progress = jsonLines(r.stderr);
  assert.ok(progress.length > 0, 'no progress lines');
  for (const p of progress) {
    assert.equal(p.type, 'progress');
    assert.equal(p.stage, 'encode');
    assert.ok(p.percent >= 0 && p.percent <= 100);
  }
  // Only JSON on stderr: no carriage-return bar mixed in.
  assert.equal(r.stderr.trim().split('\n').length, progress.length);
});

// A signal in the middle of an encode stops ffmpeg, deletes the part file and
// exits with the code the contract gives that signal. Windows has no POSIX
// signals (killing a process there ends it outright), so these run elsewhere.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`${signal} mid-encode exits ${code} and leaves nothing behind`, { skip: !FFMPEG || (process.platform === 'win32' && 'no POSIX signals'), timeout: 300000 }, async () => {
    const name = `long-${code}`;
    const clip = makeClip(`${name}.mp4`, { seconds: 30, size: '1280x720' });
    const child = spawn(process.execPath, [CLI, clip, '--json', '--progress'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    const exited = new Promise((resolve) => child.on('exit', (status) => resolve(status)));
    // Wait until the encode is really under way, so there is a part file.
    await new Promise((resolve) => child.stderr.on('data', (c) => { if (/"type":"progress"/.test(String(c))) resolve(); }));
    child.kill(signal);
    const status = await exited;
    assert.equal(status, code);
    const lines = jsonLines(stdout);
    assert.equal(lines.at(-1).type, 'done');
    assert.equal(lines.at(-1).exit, code);
    assert.deepEqual(leftovers(`${name}-edit`), [], 'a part file or an output was left');
  });
}

// The tray's pictures: one quick frame as a JPEG, and null (never a throw)
// when there is nothing to take one from.
test('a tray picture is a small JPEG, or null for a file that is not there', { skip: !FFMPEG, timeout: 60000 }, async () => {
  const engine = require('../src/engine.cjs');
  const clip = makeClip('thumb.mp4', { seconds: 2, audio: false });
  const jpeg = await engine.thumbnail(FFMPEG, clip, 0.2);
  assert.ok(Buffer.isBuffer(jpeg) && jpeg.length > 100, 'no picture came back');
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(await engine.thumbnail(FFMPEG, path.join(dir, 'missing.mp4'), 0), null);
});
