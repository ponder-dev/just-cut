'use strict';

/*
 * Cancel stops an export at once, in every phase.
 *
 *   node test/cancel.test.cjs
 *
 * The stand-ins for ffmpeg and ffprobe here ignore SIGTERM, the way a real
 * ffmpeg busy on a long clip effectively does (it finishes the stream it is
 * on first; it kept an encode going ten seconds after Cancel). A cancel that
 * only asks politely waits for them to finish and fails this test; one that
 * ends them does not.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../src/engine.cjs');

const posix = process.platform !== 'win32';   // the stand-ins are scripts with a shebang
const skip = posix ? false : 'the stand-in programs are shell-run scripts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 5000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) assert.fail('timed out waiting for ' + what);
    await sleep(25);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A program that records its pid, writes to the last argument if asked, says
// it is progressing, then idles for a minute with SIGTERM ignored.
function standIn(dir, name, { writesLast }) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(file + '.pid')}, String(process.pid));
${writesLast ? "fs.writeFileSync(process.argv[process.argv.length - 1], 'part');" : ''}
console.log('out_time_us=1000000');
setTimeout(() => {}, 60000);
`);
  fs.chmodSync(file, 0o755);
  return file;
}

const measured = { width: 640, height: 360, duration: 60, fps: 30, hasAudio: true, sampleRate: 48000, channelFix: null };
const project = (dir) => ({
  clips: [{ src: path.join(dir, 'clip.mp4'), in: 0, out: 30, speed: 1, transition: 'cut' }],
  format: 'source',
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-cancel-'));
  fs.writeFileSync(path.join(dir, 'clip.mp4'), 'x');
  return dir;
}
const tidy = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } };
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('.justcut-') || f.endsWith('made.mp4'));

test('Cancel ends an encode that ignores SIGTERM, and leaves no part file', { skip }, async () => {
  const dir = setup();
  try {
    const ffmpeg = standIn(dir, 'ffmpeg', { writesLast: true });
    const ctl = engine.control();
    const out = path.join(dir, 'made.mp4');
    const done = engine.render(ffmpeg, project(dir), { clips: [measured] }, { out, ctl });
    const settled = done.then(() => 'finished', (e) => e);
    await until('the encode to start', () => leftovers(dir).length === 1);
    const pid = Number(fs.readFileSync(ffmpeg + '.pid', 'utf8'));
    const t0 = Date.now();
    ctl.cancel();
    const result = await settled;
    assert.ok(result && result.cancelled, 'the export should end as cancelled, got ' + result);
    assert.ok(Date.now() - t0 < 2000, 'Cancel took ' + (Date.now() - t0) + ' ms');
    assert.equal(alive(pid), false, 'ffmpeg is still running');
    assert.deepEqual(leftovers(dir), [], 'a part file or an export was left behind');
  } finally { tidy(dir); }
});

test('Cancel ends the measuring that comes before the encode', { skip }, async () => {
  const dir = setup();
  try {
    const ffprobe = standIn(dir, 'ffprobe', { writesLast: false });
    const ctl = engine.control();
    const measuring = engine.probe({ ffprobe, ffmpeg: ffprobe }, [path.join(dir, 'clip.mp4')], { ctl })
      .then(() => 'finished', (e) => e);
    await until('the measuring to start', () => fs.existsSync(ffprobe + '.pid'));
    const pid = Number(fs.readFileSync(ffprobe + '.pid', 'utf8'));
    const t0 = Date.now();
    ctl.cancel();
    const result = await measuring;
    assert.ok(result && result.cancelled, 'measuring should end as cancelled, got ' + result);
    assert.ok(Date.now() - t0 < 2000, 'Cancel took ' + (Date.now() - t0) + ' ms');
    assert.equal(alive(pid), false, 'ffprobe is still running');
  } finally { tidy(dir); }
});

test('A cancel before anything has started starts nothing', { skip }, async () => {
  const dir = setup();
  try {
    const ffmpeg = standIn(dir, 'ffmpeg', { writesLast: true });
    const ctl = engine.control();
    ctl.cancel();
    await assert.rejects(
      engine.render(ffmpeg, project(dir), { clips: [measured] }, { out: path.join(dir, 'made.mp4'), ctl }),
      (e) => e.cancelled === true);
    assert.equal(fs.existsSync(ffmpeg + '.pid'), false, 'ffmpeg was started after Cancel');
    assert.deepEqual(leftovers(dir), []);
  } finally { tidy(dir); }
});
