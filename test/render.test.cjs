'use strict';

/*
 * Golden tests for the filter graph.
 *
 *   node test/render.test.cjs
 *
 * buildRender is pure, so this needs no ffmpeg, no files and no fixtures. It
 * asserts the exact arguments the app would run, character for character.
 *
 * That exactness is the point. A timeline bug does not throw: it produces a
 * video that is subtly wrong, a second short or a fade in the wrong place, and
 * the only way to catch it is to look at what was actually asked of ffmpeg.
 * Everything here is a change somebody has to make on purpose and explain.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const engine = require('../src/engine.cjs');
const plan = require('../src/plan.js');

// ---------- fixtures ----------

// A 1080p 30fps clip with sound, which is what most footage is.
const measured = (over = {}) => ({
  width: 1920, height: 1080, duration: 60, fps: 30,
  hasAudio: true, sampleRate: 48000, channelFix: null,
  ...over,
});

const clip = (over = {}) => ({
  src: '/clips/a.mp4', in: 0, out: 4, speed: 1, transition: 'cut', ...over,
});

const project = (clips, over = {}) => ({
  clips,
  format: 'source',
  pan: { x: 0.5, y: 0.5 },
  ...over,
});

// Both halves of the graph for one plain 1080p clip, reused by the tests that
// are about something else and only need a believable clip beside it.
const V = (i, from, to) =>
  `[${i}:v]trim=start=${from}:end=${to},setpts=(PTS-STARTPTS)/1.0000,fps=30,` +
  `scale=1920:1080:force_original_aspect_ratio=increase,` +
  `crop=1920:1080:x='(iw-ow)*0.500':y='(ih-oh)*0.500',setsar=1,format=yuv420p,settb=AVTB[v${i}]`;

// Padded and cut to the picture's length, so short phone audio cannot pull
// every later clip's sound ahead of its picture.
const A = (i, from, to) =>
  `[${i}:a]atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS,` +
  `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
  `apad=whole_dur=${(to - from).toFixed(3)},atrim=0:${(to - from).toFixed(3)}[a${i}]`;

/** The filter graph, split back into its stages so a failure reads. */
function graph(built) {
  return built.args[built.args.indexOf('-filter_complex') + 1].split(';');
}

function argAfter(built, flag) {
  return built.args[built.args.indexOf(flag) + 1];
}

// ---------- the whole command, once ----------

test('one clip, no transition, is the whole command', () => {
  const built = engine.buildRender(
    project([clip({ src: '/clips/a.mp4', in: 0, out: 5 })]),
    { clips: [measured()] }
  );

  assert.deepEqual(built.args, [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
    '-i', '/clips/a.mp4',
    // Two stages and no third. The audio is trimmed and conformed, and then
    // mapped straight out: nothing here treats how it sounds.
    '-filter_complex', [
      V(0, '0.000', '5.000'),
      A(0, '0.000', '5.000'),
    ].join(';'),
    '-map', '[v0]', '-map', '[a0]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-t', '5.000',
  ]);
  assert.equal(built.totalDur, 5);
});

test('lossless changes the codecs and nothing else', () => {
  const p = project([clip({ src: '/clips/a.mp4', in: 0, out: 5 })]);
  const normal = engine.buildRender(p, { clips: [measured()] });
  const lossless = engine.buildRender(p, { clips: [measured()] }, { lossless: true });

  // Same graph, same container flags, same length: only the encoders differ.
  const at = (args) => args.indexOf('-c:v');
  assert.deepEqual(lossless.args.slice(0, at(lossless.args)), normal.args.slice(0, at(normal.args)));
  assert.deepEqual(lossless.args.slice(at(lossless.args)), [
    '-c:v', 'libx264', '-preset', 'fast', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'alac',
    '-movflags', '+faststart',
    '-t', '5.000',
  ]);
});

// ---------- joining clips up ----------

test('a cut between two clips is a concat, not a transition', () => {
  const built = engine.buildRender(
    project([
      clip({ src: '/clips/a.mp4' }),
      clip({ src: '/clips/b.mp4', in: 1, out: 6 }),
    ]),
    { clips: [measured(), measured()] }
  );

  assert.deepEqual(graph(built), [
    V(0, '0.000', '4.000'),
    A(0, '0.000', '4.000'),
    V(1, '1.000', '6.000'),
    A(1, '1.000', '6.000'),
    '[v0][a0][v1][a1]concat=n=2:v=1:a=1[vx1][ax1]',
  ]);
  // One -i per clip, in timeline order, so the [n:v] labels above line up.
  assert.deepEqual(built.args.filter((a, i, all) => all[i - 1] === '-i'), ['/clips/a.mp4', '/clips/b.mp4']);

  // The last labels the join produced are the ones mapped out, with nothing
  // appended to either. That is the audio boundary: this tool assembles the
  // sound and hands it on at the level it arrived at.
  assert.equal(argAfter(built, '-map'), '[vx1]');
  assert.equal(built.args[built.args.lastIndexOf('-map') + 1], '[ax1]');

  // Two four second clips butted together, with nothing overlapping.
  assert.equal(built.totalDur, 9);
  assert.equal(argAfter(built, '-t'), '9.000');
});

test('a fade between two clips is an xfade plus an acrossfade', () => {
  const clips = [
    clip({ src: '/clips/a.mp4' }),
    clip({ src: '/clips/b.mp4', in: 1, out: 6, transition: 'fade' }),
  ];
  const built = engine.buildRender(project(clips), { clips: [measured(), measured()] });

  assert.deepEqual(graph(built), [
    V(0, '0.000', '4.000'),
    A(0, '0.000', '4.000'),
    V(1, '1.000', '6.000'),
    A(1, '1.000', '6.000'),
    '[v0][v1]xfade=transition=fade:duration=0.500:offset=3.500[vx1]',
    '[a0][a1]acrossfade=d=0.500[ax1]',
  ]);

  // The offset is where the second clip begins, and there is only one opinion
  // in the app about where that is. If these two ever disagree the picture
  // cross fades at a different moment than the playhead says it does.
  const starts = plan.clipStarts(clips);
  assert.equal(starts[1], 3.5);
  const offset = /offset=([0-9.]+)/.exec(graph(built)[4])[1];
  assert.equal(offset, starts[1].toFixed(3));

  // And the overlap really is taken out of the running time.
  assert.equal(built.totalDur, 8.5);
});

test('three clips with mixed joins chain in order', () => {
  const clips = [
    clip({ src: '/clips/a.mp4' }),
    clip({ src: '/clips/b.mp4', transition: 'fade' }),
    clip({ src: '/clips/c.mp4', out: 3, transition: 'slide' }),
  ];
  const built = engine.buildRender(project(clips), { clips: [measured(), measured(), measured()] });

  assert.deepEqual(graph(built).slice(6), [
    '[v0][v1]xfade=transition=fade:duration=0.500:offset=3.500[vx1]',
    '[a0][a1]acrossfade=d=0.500[ax1]',
    // Slide is one of ours, slideleft is what ffmpeg calls it.
    '[vx1][v2]xfade=transition=slideleft:duration=0.500:offset=7.000[vx2]',
    '[ax1][a2]acrossfade=d=0.500[ax2]',
  ]);
  assert.equal(argAfter(built, '-map'), '[vx2]');

  const starts = plan.clipStarts(clips);
  assert.deepEqual(starts, [0, 3.5, 7]);
  // Each offset is the incoming clip's own start, so the second transition is
  // measured against the assembled timeline rather than the clip before it.
  assert.equal(/offset=([0-9.]+)/.exec(graph(built)[8])[1], starts[2].toFixed(3));
});

test('a clip too short to hold a fade falls back to a cut', () => {
  // Half a second of overlap will not fit in a third of a second of clip, and
  // plan.js shortens it to nothing rather than running the timeline backwards.
  const clips = [
    clip({ src: '/clips/a.mp4', out: 0.3 }),
    clip({ src: '/clips/b.mp4', out: 0.3, transition: 'fade' }),
  ];
  const built = engine.buildRender(project(clips), { clips: [measured(), measured()] });

  assert.equal(plan.fadeDur(clips[1], clips[0]) > 0, true, 'there is some overlap available');
  assert.match(graph(built)[4], /xfade/);
  assert.equal(/duration=([0-9.]+)/.exec(graph(built)[4])[1], '0.150');
});

// ---------- speed ----------

test('speeding up chains atempo more than once', () => {
  const built = engine.buildRender(
    project([clip({ src: '/clips/a.mp4', out: 10, speed: 5 })]),
    { clips: [measured()] }
  );

  // atempo tops out at 2.0 per instance, so 5x is 2 x 2 x 1.25.
  assert.deepEqual(plan.atempoChain(5), ['atempo=2.0', 'atempo=2.0', 'atempo=1.2500']);
  assert.deepEqual(graph(built), [
    `[0:v]trim=start=0.000:end=10.000,setpts=(PTS-STARTPTS)/5.0000,fps=30,` +
    `scale=1920:1080:force_original_aspect_ratio=increase,` +
    `crop=1920:1080:x='(iw-ow)*0.500':y='(ih-oh)*0.500',setsar=1,format=yuv420p,settb=AVTB[v0]`,
    '[0:a]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS,' +
    'atempo=2.0,atempo=2.0,atempo=1.2500,' +
    'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,' +
    'apad=whole_dur=2.000,atrim=0:2.000[a0]',
  ]);

  // Ten seconds of source at 5x is two seconds of output, and the picture and
  // the sound have to arrive at that answer independently.
  assert.equal(built.totalDur, 2);
  assert.equal(argAfter(built, '-t'), '2.000');
});

test('slowing down chains atempo the other way', () => {
  const built = engine.buildRender(
    project([clip({ src: '/clips/a.mp4', out: 10, speed: 0.2 })]),
    { clips: [measured()] }
  );

  assert.match(graph(built)[1], /atempo=0\.5,atempo=0\.5,atempo=0\.8000/);
  assert.match(graph(built)[0], /setpts=\(PTS-STARTPTS\)\/0\.2000/);
  assert.equal(built.totalDur, 50);
});

// ---------- the frame ----------

test('every format reframes to the size plan.js asks for', () => {
  const cases = [
    ['source', 1920, 1080],
    ['vertical', 606, 1080],
    ['square', 1080, 1080],
    ['wide', 1920, 1080],
  ];

  for (const [format, w, h] of cases) {
    const built = engine.buildRender(
      project([clip()], { format }),
      { clips: [measured()] }
    );
    // Nothing is ever enlarged: a 9:16 slice of 1080p is 606 wide, not 1080.
    assert.deepEqual(plan.targetSize(format, 1920, 1080), { width: w, height: h }, format);
    assert.match(graph(built)[0], new RegExp(`scale=${w}:${h}:force_original_aspect_ratio=increase`), format);
    assert.match(graph(built)[0], new RegExp(`crop=${w}:${h}:`), format);
  }
});

test('widescreen from vertical footage crops the other way', () => {
  const built = engine.buildRender(
    project([clip()], { format: 'wide' }),
    { clips: [measured({ width: 1080, height: 1920 })] }
  );
  assert.match(graph(built)[0], /scale=1080:606:force_original_aspect_ratio=increase/);
});

test('an off centre pan lands in the crop, on both axes', () => {
  const built = engine.buildRender(
    project([clip()], { format: 'vertical', pan: { x: 0.25, y: 0.75 } }),
    { clips: [measured()] }
  );

  // The offset stays an ffmpeg expression rather than a number, because the
  // scaled size is not known until the filter runs.
  assert.equal(graph(built)[0],
    `[0:v]trim=start=0.000:end=4.000,setpts=(PTS-STARTPTS)/1.0000,fps=30,` +
    `scale=606:1080:force_original_aspect_ratio=increase,` +
    `crop=606:1080:x='(iw-ow)*0.250':y='(ih-oh)*0.750',setsar=1,format=yuv420p,settb=AVTB[v0]`);
});

test('the reframe runs even when the format changes nothing', () => {
  // Two clips off different cameras still have to come out the same size, or
  // concat and xfade both refuse them.
  const built = engine.buildRender(
    project([clip({ src: '/clips/a.mp4' }), clip({ src: '/clips/b.mp4' })]),
    { clips: [measured(), measured({ width: 1280, height: 720 })] }
  );
  assert.match(graph(built)[0], /scale=1920:1080/);
  assert.match(graph(built)[2], /scale=1920:1080/);
});

test('the export runs at the fastest rate in the timeline', () => {
  const built = engine.buildRender(
    project([clip({ src: '/clips/a.mp4' }), clip({ src: '/clips/b.mp4' })]),
    { clips: [measured({ fps: 30 }), measured({ fps: 60 })] }
  );
  // Going up costs file size, going down throws frames away for good.
  assert.match(graph(built)[0], /,fps=60,/);
  assert.match(graph(built)[2], /,fps=60,/);
});

// ---------- sound ----------

test('a silent clip gets silence rather than no stream at all', () => {
  const built = engine.buildRender(
    project([clip({ src: '/clips/a.mp4' }), clip({ src: '/clips/b.mp4' })]),
    { clips: [measured({ hasAudio: false }), measured()] }
  );

  // Without this, concat drops the audio from here on and everything after the
  // silent clip plays mute.
  assert.deepEqual(graph(built), [
    V(0, '0.000', '4.000'),
    'anullsrc=r=48000:cl=stereo,atrim=0:4.000[a0]',
    V(1, '0.000', '4.000'),
    A(1, '0.000', '4.000'),
    '[v0][a0][v1][a1]concat=n=2:v=1:a=1[vx1][ax1]',
  ]);
});

test('the silence matches the length of the clip after speed', () => {
  const built = engine.buildRender(
    project([clip({ src: '/clips/a.mp4', out: 9, speed: 3 })]),
    { clips: [measured({ hasAudio: false })] }
  );
  assert.match(graph(built)[1], /atrim=0:3\.000/);
});

test('a one sided recording is measured and then left exactly as it was', () => {
  // Just Cut used to promote the live channel to both sides here. It does not
  // any more: repairing a recording is changing how it sounds, and that is
  // Just Sound's job. The measurement still arrives, and plan.validate turns
  // it into a warning, but the graph must come out identical to a clip with
  // nothing wrong with it.
  const clean = engine.buildRender(project([clip()]), { clips: [measured()] });

  for (const fix of ['left', 'right']) {
    const built = engine.buildRender(
      project([clip()]),
      { clips: [measured({ channelFix: fix })] }
    );
    assert.deepEqual(built.args, clean.args, fix);
    assert.equal(graph(built)[1], A(0, '0.000', '4.000'), fix);
  }
});

test('the audio leaves at the level it arrived at', () => {
  const clips = [clip({ src: '/clips/a.mp4' }), clip({ src: '/clips/b.mp4' })];
  const built = engine.buildRender(project(clips), { clips: [measured(), measured()] });

  // Four per-clip stages and the join, and then the graph stops. Anything
  // appended after the join would be treating the sound rather than cutting
  // it, which is the line this tool does not cross.
  assert.equal(graph(built).length, 5);
  assert.equal(built.args[built.args.lastIndexOf('-map') + 1], '[ax1]');

  // No filter anywhere in the command touches loudness or channel layout,
  // beyond the resample every clip needs to be joinable at all.
  const filters = graph(built).join(';');
  assert.doesNotMatch(filters, /loudnorm|dynaudnorm|volume=|pan=stereo\|/);
});

// ---------- the two clocks have to agree ----------

test('the length buildRender reports is the length plan.js works out', () => {
  const cases = {
    'one clip': [clip({ out: 5 })],
    'two cuts': [clip(), clip({ src: '/b.mp4' })],
    'two with a fade': [clip(), clip({ src: '/b.mp4', transition: 'fade' })],
    'three mixed': [clip(), clip({ src: '/b.mp4', transition: 'fade' }), clip({ src: '/c.mp4', transition: 'slide' })],
    'sped up': [clip({ out: 10, speed: 5 })],
    'slowed down': [clip({ out: 10, speed: 0.25 })],
    'fade onto a sped up clip': [clip(), clip({ src: '/b.mp4', out: 12, speed: 4, transition: 'fade' })],
    'a clip too short for its fade': [clip({ out: 0.4 }), clip({ src: '/b.mp4', out: 0.4, transition: 'fade' })],
  };

  for (const [name, clips] of Object.entries(cases)) {
    const meas = { clips: clips.map(() => measured()) };
    const built = engine.buildRender(project(clips), meas);

    // If these two ever part company the progress bar lies on the way through
    // and -t truncates the export at the end, which is the exact failure this
    // whole split of the file exists to make visible.
    assert.equal(built.totalDur, plan.totalDuration(clips), name);
    assert.equal(argAfter(built, '-t'), plan.totalDuration(clips).toFixed(3), name);
  }
});

// ---------- refusals ----------

test('an empty timeline is refused rather than half rendered', () => {
  assert.throws(() => engine.buildRender(project([]), { clips: [] }), /nothing on the timeline/i);
});

test('the engine will not write over a clip it is reading', async () => {
  const src = '/clips/a.mp4';
  const proj = project([clip({ src })]);
  const meas = { clips: [measured()] };

  // Checked here as well as in plan.js on purpose. A guarantee enforced in one
  // place stops being enforced the day something calls the engine directly.
  assert.equal(plan.isSafeOutput(src, [src]), false);
  await assert.rejects(
    engine.render('/nonexistent/ffmpeg', proj, meas, { out: src }),
    /write over one of your own clips/i);

  // Differing only in case is the same file on macOS and Windows.
  await assert.rejects(
    engine.render('/nonexistent/ffmpeg', proj, meas, { out: '/clips/A.MP4' }),
    /write over one of your own clips/i);
});

test('an export with nowhere to go is refused before anything spawns', async () => {
  await assert.rejects(
    engine.render('/nonexistent/ffmpeg', project([clip()]), { clips: [measured()] }, {}),
    /nowhere to save/i);
});

test('a project that could not render is refused with the reason', async () => {
  const proj = project([clip({ out: 0 })]);
  await assert.rejects(
    engine.render('/nonexistent/ffmpeg', proj, { clips: [measured()] }, { out: '/clips/out.mp4' }),
    /nothing in it/i);
});

test('an existing file at the destination is left alone', async () => {
  const here = path.join(__dirname, 'render.test.cjs');
  await assert.rejects(
    engine.render('/nonexistent/ffmpeg', project([clip()]), { clips: [measured()] }, { out: here }),
    /already a file there/i);
});

// ---------- what this app is, asserted against the source ----------

test('the engine loads as plain CommonJS, with no Electron in it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.cjs'), 'utf8');
  const required = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);

  // The CLI has to be able to load this from a plain node process, so the
  // dependency list is short enough to check by eye and worth pinning.
  assert.deepEqual(required.sort(), ['./plan.js', 'node:child_process', 'node:fs', 'node:path']);
});

test('the export writes beside itself and renames into place', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.cjs'), 'utf8');

  // ffmpeg is never handed the destination directly. An interrupted export has
  // to leave a temp file, never a truncated video where a finished one was.
  // Through renameSoon, which retries the rename a Windows scanner can block.
  assert.match(source, /renameSoon\(tmp, out\)/);
  assert.match(source, /fs\.renameSync\(from, to\)/);
  assert.match(source, /existsSync\(out\)/);

  // And the temp file sits in the destination folder, because rename is only
  // atomic within one filesystem.
  assert.match(source, /path\.join\(dir, `\.justcut-/);
});

test('nothing out of scope has crept in', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.cjs'), 'utf8');

  // Just Cut cuts video down and puts the pieces in order. Everything below
  // belongs to a different app, and each one arrived in the app this was
  // ported from as a small reasonable addition.
  const banned = [
    'subtitle', 'caption', 'whisper', 'transcri', 'translat', 'publish',
    'overlay', 'lut3d', 'colorchannelmixer', 'sidechain', 'adelay',
    'http', 'fetch(', 'node:https', 'node:http', 'node:net',
    // These two were in this app, and are now Just Sound's: a loudness pass
    // and a repair of a clip recorded onto one channel. Both are changing how
    // the audio sounds, which this tool does not do. Listed here so that
    // putting either back is a decision somebody has to argue for rather than
    // something that drifts in the way it drifted in the first time.
    'loudnorm', 'dynaudnorm', 'pan=stereo',
  ];
  // amix is deliberately not on that list. It appears once, as the sink that
  // rejoins the two halves of the channel balance measurement, which is a
  // reading rather than a mix of anything, and the reading stays: the app
  // reports a one sided recording without acting on it.
  for (const word of banned) {
    assert.equal(source.toLowerCase().includes(word), false, `"${word}" is not this app's job`);
  }
});
