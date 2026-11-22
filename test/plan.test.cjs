'use strict';

/*
 * The maths that decides where everything sits.
 *
 *   node test/plan.test.cjs
 *
 * No framework. If it prints "ok" and exits 0, the timeline the editor draws
 * and the timeline the engine renders are the same timeline.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const plan = require('../src/plan.js');

// A clip is mostly boilerplate, so tests only say the part that matters.
function clip(over = {}) {
  return { src: '/tmp/a.mp4', in: 0, out: 10, speed: 1, transition: 'cut', ...over };
}

function measure(over = {}) {
  return {
    width: 1920, height: 1080, duration: 60, fps: 30,
    hasAudio: true, sampleRate: 48000, channelFix: null, ...over,
  };
}

const close = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} vs ${b}`);

test('a clip lasts its trim divided by its speed', () => {
  assert.equal(plan.clipDuration(clip({ in: 2, out: 12 })), 10);
  assert.equal(plan.clipDuration(clip({ in: 2, out: 12, speed: 2 })), 5);
  assert.equal(plan.clipDuration(clip({ in: 2, out: 12, speed: 0.5 })), 20);
});

test('a clip trimmed backwards has no length rather than a negative one', () => {
  assert.equal(plan.clipDuration(clip({ in: 10, out: 4 })), 0);
  assert.equal(plan.clipDuration(clip({ speed: 0 })), 0);
  assert.equal(plan.clipDuration(null), 0);
});

test('cuts lay clips end to end', () => {
  const clips = [clip({ out: 4 }), clip({ out: 6 }), clip({ out: 5 })];
  assert.deepEqual(plan.clipStarts(clips), [0, 4, 10]);
  assert.equal(plan.totalDuration(clips), 15);
});

test('an empty timeline is zero long and has no starts', () => {
  assert.deepEqual(plan.clipStarts([]), []);
  assert.equal(plan.totalDuration([]), 0);
  assert.equal(plan.totalDuration(undefined), 0);
});

test('a transition overlaps the clips it joins, so the timeline gets shorter', () => {
  const clips = [clip({ out: 10 }), clip({ out: 10, transition: 'fade' })];
  assert.equal(plan.fadeDur(clips[1], clips[0]), 0.5);
  assert.deepEqual(plan.clipStarts(clips), [0, 9.5]);
  assert.equal(plan.totalDuration(clips), 19.5);
});

test('overlaps accumulate down a chain', () => {
  const clips = [
    clip({ out: 10 }),
    clip({ out: 10, transition: 'fade' }),
    clip({ out: 10, transition: 'slide' }),
  ];
  assert.deepEqual(plan.clipStarts(clips), [0, 9.5, 19]);
  assert.equal(plan.totalDuration(clips), 29);
});

test('a transition can never eat more than half the shorter clip', () => {
  // Half a second wanted, but the incoming clip is only 0.4s long.
  const clips = [clip({ out: 10 }), clip({ out: 0.4, transition: 'fade' })];
  close(plan.fadeDur(clips[1], clips[0]), 0.2, 'capped at half the shorter clip');

  // And the same when it is the outgoing clip that is short.
  const other = [clip({ out: 0.4 }), clip({ out: 10, transition: 'fade' })];
  close(plan.fadeDur(other[1], other[0]), 0.2, 'either side can be the short one');
});

test('a tiny clip gets a cut rather than a floor that overruns it', () => {
  // The version this was ported from floored the overlap at 0.1s, which on a
  // clip this short is longer than the clip can spare.
  const clips = [clip({ out: 10 }), clip({ out: 0.1, transition: 'fade' })];
  const overlap = plan.fadeDur(clips[1], clips[0]);
  assert.ok(overlap <= plan.clipDuration(clips[1]) / 2 + 1e-9, 'must not exceed half the clip');
  close(overlap, 0.05, 'half of a tenth of a second');
});

test('no arrangement of transitions can make the timeline run backwards', () => {
  for (const len of [0.05, 0.2, 0.9, 3, 30]) {
    for (const speed of [0.25, 1, 4]) {
      for (const wanted of [0.5, 2, 60]) {
        const clips = [
          clip({ out: len, speed }),
          clip({ out: len, speed, transition: 'fade', transitionDuration: wanted }),
          clip({ out: len, speed, transition: 'slide', transitionDuration: wanted }),
        ];
        const starts = plan.clipStarts(clips);
        assert.ok(starts[1] >= starts[0], `starts went backwards at ${len}/${speed}/${wanted}`);
        assert.ok(starts[2] >= starts[1], `starts went backwards at ${len}/${speed}/${wanted}`);
        assert.ok(plan.totalDuration(clips) > 0, 'and the total stays positive');
      }
    }
  }
});

test('speed shrinks the room a transition has', () => {
  // Two seconds of source at 4x is half a second of output, so half of that.
  const clips = [clip({ out: 2, speed: 4 }), clip({ out: 2, speed: 4, transition: 'fade' })];
  close(plan.fadeDur(clips[1], clips[0]), 0.25, 'the cap is on output seconds, not source seconds');
});

test('the first clip has nothing to blend with', () => {
  assert.equal(plan.fadeDur(clip({ transition: 'fade' }), null), 0);
  const clips = [clip({ out: 5, transition: 'fade' }), clip({ out: 5 })];
  assert.deepEqual(plan.clipStarts(clips), [0, 5]);
});

test('a cut has no overlap and an unknown join is treated as one', () => {
  assert.equal(plan.fadeDur(clip({ transition: 'cut' }), clip()), 0);
  assert.equal(plan.fadeDur(clip({ transition: 'wipe' }), clip()), 0);
  assert.equal(plan.fadeDur(clip({ transition: undefined }), clip()), 0);
});

test('a project can ask for a longer transition than the default', () => {
  const clips = [clip({ out: 10 }), clip({ out: 10, transition: 'fade', transitionDuration: 2 })];
  assert.equal(plan.fadeDur(clips[1], clips[0]), 2);
  assert.equal(plan.totalDuration(clips), 18);
});

test('locateClip answers with the clip and where it lands in the source file', () => {
  const clips = [clip({ in: 5, out: 15 }), clip({ in: 100, out: 110 })];
  assert.deepEqual(plan.locateClip(clips, 0), { index: 0, sourceTime: 5 });
  assert.deepEqual(plan.locateClip(clips, 4), { index: 0, sourceTime: 9 });
  assert.deepEqual(plan.locateClip(clips, 12), { index: 1, sourceTime: 102 });
});

test('locateClip is exact on a boundary', () => {
  const clips = [clip({ out: 10 }), clip({ in: 3, out: 13 })];
  // The boundary belongs to the incoming clip, at its very first frame.
  assert.deepEqual(plan.locateClip(clips, 10), { index: 1, sourceTime: 3 });
  // And the last instant of the timeline is the outgoing clip's last frame.
  assert.deepEqual(plan.locateClip(clips, 20), { index: 1, sourceTime: 13 });
});

test('locateClip prefers the incoming clip while two are on screen', () => {
  const clips = [clip({ out: 10 }), clip({ in: 0, out: 10, transition: 'fade' })];
  const during = plan.locateClip(clips, 9.6);
  assert.equal(during.index, 1, 'a playhead inside the overlap is heading for the new shot');
  close(during.sourceTime, 0.1, 'and a tenth of a second into it');
});

test('locateClip reads the source clock at the clip speed', () => {
  const clips = [clip({ in: 10, out: 30, speed: 2 })];
  assert.equal(plan.totalDuration(clips), 10);
  assert.deepEqual(plan.locateClip(clips, 5), { index: 0, sourceTime: 20 });
});

test('locateClip returns nothing past either end', () => {
  const clips = [clip({ out: 10 })];
  assert.equal(plan.locateClip(clips, 10.001), null);
  assert.equal(plan.locateClip(clips, 1e6), null);
  assert.equal(plan.locateClip(clips, -0.001), null);
  assert.equal(plan.locateClip([], 0), null, 'nothing on the timeline means nothing to find');
  assert.equal(plan.locateClip(clips, NaN), null);
});

test('splitting a clip keeps the timeline exactly as long', () => {
  const clips = [clip({ in: 0, out: 12 }), clip({ in: 4, out: 20, speed: 2 })];
  const before = plan.totalDuration(clips);
  for (const [index, at] of [[0, 3], [1, 10]]) {
    const after = plan.splitAt(clips, index, at);
    assert.equal(after.length, 3);
    close(plan.totalDuration(after), before, 'a split adds no time and removes none');
  }
});

test('the two halves of a split are contiguous and joined by a cut', () => {
  const clips = [clip({ in: 2, out: 12, transition: 'cut', speed: 1.5 })];
  const after = plan.splitAt(clips, 0, 7);
  assert.equal(after[0].out, 7);
  assert.equal(after[1].in, 7);
  assert.equal(after[1].transition, 'cut', 'the halves were never apart, so nothing blends them');
  assert.equal(after[0].speed, 1.5, 'and both halves keep the speed');
  assert.equal(after[1].speed, 1.5);
});

test('a split with a transition after it still totals the same', () => {
  const clips = [clip({ out: 10 }), clip({ out: 10, transition: 'fade' })];
  const before = plan.totalDuration(clips);
  const after = plan.splitAt(clips, 0, 5);
  close(plan.totalDuration(after), before, 'the fade still had room, so nothing moved');
});

test('splitAt does not touch what it was given', () => {
  const clips = [clip({ in: 0, out: 10 })];
  const copy = JSON.parse(JSON.stringify(clips));
  const after = plan.splitAt(clips, 0, 5);
  assert.deepEqual(clips, copy, 'the original array is untouched');
  assert.notEqual(after, clips);
});

test('a split outside the trimmed range is refused', () => {
  const clips = [clip({ in: 2, out: 12 })];
  for (const at of [2, 12, 0, 99, NaN, undefined]) {
    assert.equal(plan.splitAt(clips, 0, at).length, 1, `${at} is not a place to cut`);
  }
  assert.equal(plan.splitAt(clips, 9, 5).length, 1, 'and neither is a clip that is not there');
  assert.equal(plan.splitAt([], 0, 1).length, 0);
});

test('moveClip reorders without mutating', () => {
  const clips = [clip({ src: 'a' }), clip({ src: 'b' }), clip({ src: 'c' })];
  const after = plan.moveClip(clips, 2, 0);
  assert.deepEqual(after.map((c) => c.src), ['c', 'a', 'b']);
  assert.deepEqual(clips.map((c) => c.src), ['a', 'b', 'c'], 'the original order is untouched');
});

test('whatever ends up first is forced back to a cut', () => {
  const clips = [clip({ src: 'a' }), clip({ src: 'b', transition: 'fade' })];
  const after = plan.moveClip(clips, 1, 0);
  assert.equal(after[0].transition, 'cut', 'there is nothing before it to blend with');
  assert.equal(clips[1].transition, 'fade', 'and the original object was not edited');
});

test('a move that goes nowhere changes nothing', () => {
  const clips = [clip({ src: 'a' }), clip({ src: 'b' })];
  assert.deepEqual(plan.moveClip(clips, 1, 1).map((c) => c.src), ['a', 'b']);
  assert.deepEqual(plan.moveClip([], 0, 1), []);
});

test('a move off the end lands at the end', () => {
  const clips = [clip({ src: 'a' }), clip({ src: 'b' }), clip({ src: 'c' })];
  assert.deepEqual(plan.moveClip(clips, 0, 99).map((c) => c.src), ['b', 'c', 'a']);
  assert.deepEqual(plan.moveClip(clips, 0, -5).map((c) => c.src), ['a', 'b', 'c']);
});

test('atempo is left out entirely at normal speed', () => {
  assert.deepEqual(plan.atempoChain(1), []);
  assert.deepEqual(plan.atempoChain(1.0005), []);
  assert.deepEqual(plan.atempoChain(0), [], 'and a speed that is not a speed asks for nothing');
});

test('atempo chains multiply out to the speed asked for', () => {
  for (const speed of [0.1, 0.25, 0.4, 0.5, 0.75, 1.5, 2, 2.5, 4, 8, 10]) {
    const chain = plan.atempoChain(speed);
    assert.ok(chain.length >= 1, `${speed}x needs at least one filter`);
    const factors = chain.map((f) => Number(f.split('=')[1]));
    const product = factors.reduce((a, b) => a * b, 1);
    assert.ok(Math.abs(product - speed) < 0.001, `${speed}x chained to ${product}`);
    for (const f of factors) {
      assert.ok(f >= 0.5 && f <= 2.0, `${f} is outside what one atempo accepts`);
    }
  }
});

test('atempo only chains when it has to', () => {
  assert.equal(plan.atempoChain(1.5).length, 1);
  assert.equal(plan.atempoChain(2).length, 1, 'two is still one filter, at the top of its range');
  assert.equal(plan.atempoChain(4).length, 2);
  assert.equal(plan.atempoChain(8).length, 3);
  assert.equal(plan.atempoChain(0.5).length, 1);
  assert.equal(plan.atempoChain(0.25).length, 2);
});

test('the output frame is always even, because h264 refuses otherwise', () => {
  const sizes = [[1920, 1080], [1080, 1920], [1919, 1079], [641, 481], [3840, 2160], [1, 1]];
  for (const format of Object.keys(plan.FORMATS)) {
    for (const [w, h] of sizes) {
      const t = plan.targetSize(format, w, h);
      assert.equal(t.width % 2, 0, `${format} ${w}x${h} width ${t.width}`);
      assert.equal(t.height % 2, 0, `${format} ${w}x${h} height ${t.height}`);
      assert.ok(t.width >= 2 && t.height >= 2, 'and never zero');
    }
  }
});

test('the source format leaves the frame alone apart from making it even', () => {
  assert.deepEqual(plan.targetSize('source', 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(plan.targetSize('source', 1921, 1081), { width: 1920, height: 1080 });
});

test('reframing never invents pixels the source does not have', () => {
  for (const format of Object.keys(plan.FORMATS)) {
    const t = plan.targetSize(format, 1920, 1080);
    assert.ok(t.width <= 1920, `${format} width grew to ${t.width}`);
    assert.ok(t.height <= 1080, `${format} height grew to ${t.height}`);
  }
});

test('each format comes out the shape it claims to be', () => {
  for (const [name, shape] of Object.entries(plan.FORMATS)) {
    if (!shape.ratio) continue;
    const t = plan.targetSize(name, 1920, 1080);
    assert.ok(Math.abs(t.width / t.height - shape.ratio) < 0.01, `${name} came out ${t.width}x${t.height}`);
  }
  assert.deepEqual(plan.targetSize('square', 1920, 1080), { width: 1080, height: 1080 });
  assert.deepEqual(plan.targetSize('wide', 1920, 1080), { width: 1920, height: 1080 });
});

test('a format nobody has heard of falls back to leaving the frame alone', () => {
  assert.deepEqual(plan.targetSize('hexagonal', 1280, 720), { width: 1280, height: 720 });
});

test('an unmeasured source still gets a sensible frame', () => {
  for (const bad of [[0, 0], [undefined, undefined], [1920, 0]]) {
    const t = plan.targetSize('source', bad[0], bad[1]);
    assert.equal(t.width % 2, 0);
    assert.ok(t.width > 0 && t.height > 0);
  }
});

test('the crop always fits inside the source frame', () => {
  const pans = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }, {}, undefined];
  for (const [w, h] of [[1920, 1080], [1080, 1920], [1000, 1000], [1919, 1079]]) {
    for (const format of Object.keys(plan.FORMATS)) {
      const t = plan.targetSize(format, w, h);
      for (const pan of pans) {
        const c = plan.cropRect(w, h, t.width, t.height, pan);
        assert.ok(c.x >= 0 && c.y >= 0, 'no negative offsets');
        assert.ok(c.x + c.width <= w, `${format} ${w}x${h} crop runs off the right edge`);
        assert.ok(c.y + c.height <= h, `${format} ${w}x${h} crop runs off the bottom`);
        assert.equal(c.width % 2, 0);
        assert.equal(c.height % 2, 0);
        assert.equal(c.x % 2, 0, 'offsets are even too, for the sake of 4:2:0 chroma');
        assert.equal(c.y % 2, 0);
      }
    }
  }
});

test('the crop for a format is exactly the size that format exports at', () => {
  // If these ever disagree the export scales for no reason, which costs
  // quality on a frame that was already the right size.
  for (const [w, h] of [[1920, 1080], [1080, 1920], [1000, 1000], [3840, 2160], [640, 480]]) {
    for (const format of Object.keys(plan.FORMATS)) {
      const t = plan.targetSize(format, w, h);
      const c = plan.cropRect(w, h, t.width, t.height, { x: 0.5, y: 0.5 });
      assert.equal(c.width, t.width, `${format} ${w}x${h} width`);
      assert.equal(c.height, t.height, `${format} ${w}x${h} height`);
    }
  }
});

test('pan runs from one edge to the other', () => {
  const left = plan.cropRect(1920, 1080, 1080, 1080, { x: 0, y: 0.5 });
  const middle = plan.cropRect(1920, 1080, 1080, 1080, { x: 0.5, y: 0.5 });
  const right = plan.cropRect(1920, 1080, 1080, 1080, { x: 1, y: 0.5 });
  assert.equal(left.x, 0, 'hard left is the left edge, not a pixel in from it');
  assert.equal(right.x, 1920 - 1080);
  assert.ok(middle.x > left.x && middle.x < right.x);
  assert.equal(left.y, 0, 'a full height crop has no room to pan vertically');
  assert.equal(right.y, 0);
});

test('pan works on the other axis too', () => {
  const top = plan.cropRect(1080, 1920, 1080, 1080, { x: 0.5, y: 0 });
  const bottom = plan.cropRect(1080, 1920, 1080, 1080, { x: 0.5, y: 1 });
  assert.equal(top.y, 0);
  assert.equal(bottom.y, 1920 - 1080);
  assert.equal(top.x, 0);
});

test('pan outside 0 to 1 is pulled back to the edge', () => {
  const past = plan.cropRect(1920, 1080, 1080, 1080, { x: 5, y: -3 });
  assert.equal(past.x, 1920 - 1080);
  assert.equal(past.y, 0);
  const nonsense = plan.cropRect(1920, 1080, 1080, 1080, { x: 'left', y: null });
  assert.equal(nonsense.x, 420, 'unreadable pan centres rather than throws');
});

test('a crop of a frame that was never measured is empty rather than wrong', () => {
  assert.deepEqual(plan.cropRect(0, 0, 1080, 1080, {}), { x: 0, y: 0, width: 0, height: 0 });
});

test('a sound project has nothing to say about itself', () => {
  const project = {
    ...plan.DEFAULT_PROJECT,
    clips: [clip({ out: 10 }), clip({ out: 10, transition: 'fade' })],
  };
  assert.deepEqual(plan.validate(project, { clips: [measure(), measure()] }), []);
});

test('an empty timeline is the first thing reported and the only thing', () => {
  const problems = plan.validate({ clips: [] }, { clips: [] });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, 'error');
  assert.match(problems[0].message, /nothing on the timeline/i);
  assert.equal(plan.validate({}, null).length, 1, 'and so is no project at all');
});

test('a clip trimmed to nothing is an error', () => {
  const problems = plan.validate({ clips: [clip({ in: 5, out: 5 })] }, { clips: [measure()] });
  assert.ok(problems.some((x) => x.level === 'error' && /nothing in it/i.test(x.message)));

  const backwards = plan.validate({ clips: [clip({ in: 9, out: 4 })] }, { clips: [measure()] });
  assert.ok(backwards.some((x) => x.level === 'error'));
});

test('a trim past the end of the file is an error', () => {
  const problems = plan.validate({ clips: [clip({ in: 0, out: 90 })] }, { clips: [measure({ duration: 60 })] });
  assert.ok(problems.some((x) => x.level === 'error' && /only 60.00s long/.test(x.message)));

  // Trimmed to exactly the end is the most ordinary edit there is.
  assert.deepEqual(plan.validate({ clips: [clip({ in: 0, out: 60 })] }, { clips: [measure({ duration: 60 })] }), []);
});

test('a trim before the start of the file is an error', () => {
  const problems = plan.validate({ clips: [clip({ in: -3, out: 10 })] }, { clips: [measure()] });
  assert.ok(problems.some((x) => x.level === 'error' && /before the beginning/i.test(x.message)));
});

test('a clip with no trim points at all is an error', () => {
  const problems = plan.validate({ clips: [clip({ in: undefined, out: undefined })] }, { clips: [measure()] });
  assert.ok(problems.some((x) => x.level === 'error' && /no trim points/i.test(x.message)));
});

test('a clip with no file behind it is an error', () => {
  const problems = plan.validate({ clips: [clip({ src: '' })] }, { clips: [measure()] });
  assert.ok(problems.some((x) => x.level === 'error' && /no file/i.test(x.message)));
});

test('an impossible speed is an error and an extreme one is a warning', () => {
  const zero = plan.validate({ clips: [clip({ speed: 0 })] }, { clips: [measure()] });
  assert.ok(zero.some((x) => x.level === 'error' && /not a speed/i.test(x.message)));

  const silly = plan.validate({ clips: [clip({ speed: 40 })] }, { clips: [measure()] });
  assert.ok(silly.some((x) => x.level === 'error'));

  const extreme = plan.validate({ clips: [clip({ speed: 6 })] }, { clips: [measure()] });
  assert.ok(extreme.some((x) => x.level === 'warning' && /sound/i.test(x.message)));
  assert.ok(!extreme.some((x) => x.level === 'error'));

  const slow = plan.validate({ clips: [clip({ speed: 0.15 })] }, { clips: [measure()] });
  assert.ok(slow.some((x) => x.level === 'warning'));
});

test('a transition longer than the clips it joins is a warning, not a failure', () => {
  const clips = [clip({ out: 0.6 }), clip({ out: 0.6, transition: 'fade', transitionDuration: 2 })];
  const problems = plan.validate({ clips }, { clips: [measure(), measure()] });
  assert.ok(problems.some((x) => x.level === 'warning' && /shortened to 0.30s/.test(x.message)));
  assert.ok(!problems.some((x) => x.level === 'error'), 'it still exports, just shorter');
});

test('a transition on the first clip is a warning', () => {
  const problems = plan.validate({ clips: [clip({ transition: 'fade' })] }, { clips: [measure()] });
  assert.ok(problems.some((x) => x.level === 'warning' && /first clip/i.test(x.message)));
});

test('a transition nobody has heard of is a warning and becomes a cut', () => {
  const clips = [clip(), clip({ transition: 'starwipe' })];
  const problems = plan.validate({ clips }, { clips: [measure(), measure()] });
  assert.ok(problems.some((x) => x.level === 'warning' && /starwipe/.test(x.message)));
  assert.equal(plan.fadeDur(clips[1], clips[0]), 0);
});

test('mixed frame rates are worth mentioning, tiny differences are not', () => {
  const clips = [clip(), clip()];
  const mixed = plan.validate({ clips }, { clips: [measure({ fps: 30 }), measure({ fps: 60 })] });
  assert.ok(mixed.some((x) => x.level === 'warning' && /frame rates/i.test(x.message)));

  const near = plan.validate({ clips }, { clips: [measure({ fps: 23.976 }), measure({ fps: 24 })] });
  assert.ok(!near.some((x) => /frame rates/i.test(x.message)), '23.976 against 24 is not news');
});

test('a clip recorded onto one channel is a warning, not something done about', () => {
  const problems = plan.validate(
    { clips: [clip({ src: '/tmp/interview.mp4' })] },
    { clips: [measure({ channelFix: 'left' })] }
  );

  // Named, so it is obvious which clip to go and look at, and pointed at the
  // tool that fixes it. Just Cut measures this and reports it; it does not
  // repair it, because repairing it would be changing how the audio sounds.
  const warned = problems.filter((x) => x.level === 'warning' && /one channel/i.test(x.message));
  assert.equal(warned.length, 1);
  assert.match(warned[0].message, /interview\.mp4/);
  assert.match(warned[0].message, /Just Sound/);

  // A warning and never an error: the export is fine, it just sounds the way
  // it was recorded.
  assert.ok(!problems.some((x) => x.level === 'error'));

  // Both sides, and nothing said about audio that is merely unbalanced.
  assert.equal(
    plan.validate({ clips: [clip()] }, { clips: [measure({ channelFix: 'right' })] }).length, 1);
  assert.deepEqual(plan.validate({ clips: [clip()] }, { clips: [measure()] }), []);
});

test('a format that does not exist is an error', () => {
  const problems = plan.validate({ clips: [clip()], format: 'octagonal' }, { clips: [measure()] });
  assert.ok(problems.some((x) => x.level === 'error' && /octagonal/.test(x.message)));
});

test('validation copes with never having probed anything', () => {
  const problems = plan.validate({ clips: [clip()] }, undefined);
  assert.deepEqual(problems, [], 'without measurements there is nothing to contradict');
});

test('the defaults are a project that validates as soon as a clip is added', () => {
  assert.deepEqual(plan.DEFAULT_PROJECT.clips, []);
  assert.equal(plan.FORMATS[plan.DEFAULT_PROJECT.format].ratio, null);
  assert.equal(plan.DEFAULT_PROJECT.pan.x, 0.5);
  const project = { ...plan.DEFAULT_PROJECT, clips: [clip()] };
  assert.deepEqual(plan.validate(project, { clips: [measure()] }), []);

  // A project is a timeline and a frame. There is nothing in it about how the
  // sound is treated, because this app does not treat sound: it cuts it.
  assert.deepEqual(Object.keys(plan.DEFAULT_PROJECT).sort(), ['clips', 'format', 'pan']);
});

test('every transition names an xfade or admits it is a cut', () => {
  for (const [name, t] of Object.entries(plan.TRANSITIONS)) {
    assert.equal(typeof t.label, 'string');
    assert.ok(t.duration >= 0);
    if (name === 'cut') assert.equal(t.xfade, null);
    else assert.equal(typeof t.xfade, 'string');
  }
  assert.deepEqual(Object.keys(plan.TRANSITIONS), ['cut', 'fade', 'slide']);
});
