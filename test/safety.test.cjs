'use strict';

/*
 * The promise: your footage is only ever read.
 *
 *   node test/safety.test.cjs
 *
 * Just Cut writes in one place, the path outputPath returns. So the promise
 * reduces to a single claim: that path can never be a file the project reads
 * from, and never a file that already exists. This tries hard to make it be.
 *
 * The engine and the CLI enforce the same rule again on their own side, and
 * they do it by calling isSafeOutput, so this file is testing the thing they
 * all rely on rather than a description of it.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const plan = require('../src/plan.js');

// plan.js joins paths itself, keeping the folder's own separator, so tests on
// a POSIX-style folder compare with POSIX joins on every platform.
const posix = path.posix;
const DIR = '/tmp/some folder';

// Names chosen to collide if the naming rule were sloppy: ones that already
// look like our output, ones differing only by case, ones already carrying the
// numbered suffix the collision handler adds, and ones with barely any name at
// all to build from.
const NASTY = [
  'clip.mp4', 'clip-edit.mp4', 'clip-edit 2.mp4', 'clip-edit 999.mp4', 'clip-edit (2).mp4',
  'clip-edit-edit.mp4', 'CLIP.MP4', 'Clip-Edit.mp4', 'clip.MP4', 'CLIP-EDIT 2.MP4',
  'a.mp4', '-edit.mp4', 'edit.mp4', '.mp4', 'no-extension', '',
  'two.dots.mp4', 'spaces everywhere.mp4', 'ünïcodé.mp4', "quote'name.mp4",
  'clip.mov', 'clip.MOV', 'clip.webm',
];

test('the output is never one of the clips, whatever they are called', () => {
  for (const name of NASTY) {
    for (const ext of ['.mp4', '.mov']) {
      const source = posix.join(DIR, name);
      const out = plan.outputPath(source, DIR, ext);
      assert.notEqual(out, source, `${name} -> ${out}`);
      assert.notEqual(out.toLowerCase(), source.toLowerCase(),
        `${name} -> ${out} differs only by case, which is the same file on a mac`);
      assert.equal(plan.isSafeOutput(out, [source]), true, `${name} -> ${out}`);
    }
  }
});

test('the output is never any of the clips, not just the first one', () => {
  // A project is many files, and the one the output is named after is only the
  // first of them. Every other clip has to be just as untouchable.
  const inputs = NASTY.map((n) => posix.join(DIR, n)).filter((p) => p !== DIR);
  for (const name of NASTY) {
    const out = plan.outputPath(posix.join(DIR, name), DIR, '.mp4', () => false, inputs);
    assert.equal(plan.isSafeOutput(out, inputs), true, `${name} -> ${out}`);
  }
});

test('it stays away even when every name it tries is taken', () => {
  for (const name of NASTY) {
    const source = posix.join(DIR, name);
    // Claim every path in the world exists, so the collision loop runs out.
    const out = plan.outputPath(source, DIR, '.mp4', () => true);
    assert.notEqual(out, source);
    assert.notEqual(out.toLowerCase(), source.toLowerCase());
    assert.equal(posix.dirname(out), DIR, 'and it still lands where it was asked to');
  }
});

test('a taken name is numbered up until one is free', () => {
  const taken = new Set([
    posix.join(DIR, 'clip-edit.mp4'),
    posix.join(DIR, 'clip-edit 2.mp4'),
    posix.join(DIR, 'clip-edit 3.mp4'),
  ]);
  const out = plan.outputPath(posix.join(DIR, 'clip.mp4'), DIR, '.mp4', (p) => taken.has(p));
  assert.equal(out, posix.join(DIR, 'clip-edit 4.mp4'));
});

test('a clip that already looks like an output gets its own name, not the same one', () => {
  const source = posix.join(DIR, 'clip-edit.mp4');
  const out = plan.outputPath(source, DIR, '.mp4');
  assert.equal(out, posix.join(DIR, 'clip-edit-edit.mp4'));
  assert.notEqual(out, source);
});

test('a name that differs only by case is treated as the same file', () => {
  // macOS and Windows are both case insensitive by default, so returning
  // clip-edit.mp4 while CLIP-EDIT.MP4 sits in the folder is an overwrite.
  const inputs = [posix.join(DIR, 'CLIP-EDIT.MP4')];
  const out = plan.outputPath(posix.join(DIR, 'clip.mp4'), DIR, '.mp4', () => false, inputs);
  assert.equal(out, posix.join(DIR, 'clip-edit 2.mp4'));
  assert.notEqual(out.toLowerCase(), inputs[0].toLowerCase());
});

test('it lands where it was told to, not beside the clip', () => {
  const out = plan.outputPath('/tmp/somewhere else/clip.mp4', DIR, '.mp4');
  assert.equal(posix.dirname(out), DIR);
});

test('with no folder given it lands beside the first clip', () => {
  for (const dir of ['', null, undefined]) {
    const out = plan.outputPath('/tmp/a folder/clip.mp4', dir, '.mp4');
    assert.equal(out, '/tmp/a folder/clip-edit.mp4');
  }
});

test('a clip with no name at all still gets somewhere safe to go', () => {
  for (const src of ['', undefined, null, '/', '   ']) {
    const out = plan.outputPath(src, DIR, '.mp4');
    assert.ok(out.length > DIR.length, `${JSON.stringify(src)} -> ${out}`);
    assert.equal(plan.isSafeOutput(out, [src]), true);
    assert.match(out, /\.mp4$/);
  }
});

test('a missing extension becomes one rather than a file with no suffix', () => {
  assert.match(plan.outputPath('/tmp/clip.mov', DIR, ''), /\.mp4$/);
  assert.match(plan.outputPath('/tmp/clip.mov', DIR, undefined), /\.mp4$/);
  assert.equal(plan.outputPath('/tmp/clip.mov', DIR, 'mov'), posix.join(DIR, 'clip-edit.mov'),
    'and an extension given without its dot still gets one');
});

test('windows paths keep their separator', () => {
  const out = plan.outputPath('C:\\Users\\me\\clip.mp4', 'C:\\Users\\me', '.mp4');
  assert.equal(out, 'C:\\Users\\me\\clip-edit.mp4');
  assert.equal(plan.isSafeOutput(out, ['C:\\Users\\me\\clip.mp4']), true);
});

test('isSafeOutput says no to the file it was given', () => {
  assert.equal(plan.isSafeOutput('/tmp/a.mp4', ['/tmp/a.mp4']), false);
  assert.equal(plan.isSafeOutput('/tmp/a-edit.mp4', ['/tmp/a.mp4']), true);
  assert.equal(plan.isSafeOutput('/tmp/c.mp4', ['/tmp/a.mp4', '/tmp/b.mp4', '/tmp/c.mp4']), false);
});

test('isSafeOutput is not fooled by how a path is written', () => {
  const input = '/tmp/folder/a.mp4';
  for (const same of [
    '/tmp/folder/a.mp4', '/tmp//folder/a.mp4', '/tmp/./folder/a.mp4',
    '/tmp/folder/A.MP4', '/TMP/FOLDER/a.mp4', '\\tmp\\folder\\a.mp4',
  ]) {
    assert.equal(plan.isSafeOutput(same, [input]), false, `${same} is the same file as ${input}`);
  }
  assert.equal(plan.isSafeOutput('/tmp/folder/a.mp4', ['/tmp/folder/a.mp4/']), false,
    'a trailing slash does not make it a different file');
});

test('isSafeOutput refuses to call nothing a safe path', () => {
  for (const nothing of ['', undefined, null, '/', 0, false]) {
    assert.equal(plan.isSafeOutput(nothing, ['/tmp/a.mp4']), false, `${JSON.stringify(nothing)}`);
  }
});

test('isSafeOutput copes with a list that is not a list', () => {
  assert.equal(plan.isSafeOutput('/tmp/out.mp4', undefined), true);
  assert.equal(plan.isSafeOutput('/tmp/out.mp4', []), true);
  assert.equal(plan.isSafeOutput('/tmp/out.mp4', '/tmp/out.mp4'), false, 'one path, not wrapped');
  assert.equal(plan.isSafeOutput('/tmp/out.mp4', [null, undefined, '', '/tmp/in.mp4']), true,
    'gaps in the list are gaps, not matches');
});

test('outputPath and isSafeOutput agree with each other, always', () => {
  // The two enforcement points have to be the same rule, or one of them is
  // a decoration. Anything outputPath hands back must pass the cheap check.
  const inputs = NASTY.map((n) => posix.join(DIR, n));
  for (const name of NASTY) {
    for (const exists of [() => false, () => true, (p) => p.includes(' 2.')]) {
      const out = plan.outputPath(posix.join(DIR, name), DIR, '.mp4', exists, inputs);
      assert.equal(plan.isSafeOutput(out, inputs), true, `${name} -> ${out}`);
    }
  }
});

test('the decision layer cannot touch a file even if it wanted to', () => {
  // Reading the source is the point: this asserts on the code that ships
  // rather than on a promise about it. A module with no way to reach the disk
  // or the network cannot break the rule by accident later.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'plan.js'), 'utf8');
  assert.doesNotMatch(source, /\brequire\s*\(/, 'no requires, so nothing can be pulled in');
  assert.doesNotMatch(source, /(^|\n)\s*import[\s{]/, 'and no imports either');
  assert.doesNotMatch(source, /\bfs\./, 'no filesystem');
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket|https?:\/\/[^\s)]*\?)/,
    'and nothing that reaches the network');
});

test('a Windows device name is never a safe output, with or without an extension', () => {
  // Writing to one writes to the device, so the export the person is promised
  // never exists. Refused on every platform, because scripts travel.
  for (const name of ['con', 'NUL', 'nul.mp4', 'Con.MP4', 'prn.mp4', 'aux.mp4', 'com1.mp4',
    'COM9', 'lpt1.mp4', 'lpt9.x.mp4', 'con .mp4', 'com\u00b9.mp4']) {
    const out = posix.join(DIR, name);
    assert.equal(plan.isDeviceName(out), true, `${name} was not seen as a device`);
    assert.equal(plan.isSafeOutput(out, []), false, name);
  }
  // Only the whole name before the first dot counts.
  for (const name of ['console.mp4', 'nullable.mp4', 'com10.mp4', 'lpt0.mp4', 'icon.mp4',
    'my con.mp4', 'con-edit.mp4', '.con']) {
    const out = posix.join(DIR, name);
    assert.equal(plan.isDeviceName(out), false, `${name} was taken for a device`);
    assert.equal(plan.isSafeOutput(out, []), true, name);
  }
  // And a Windows path with backslashes is read the same way.
  assert.equal(plan.isDeviceName('C:\\Users\\me\\Videos\\NUL.mp4'), true);
  assert.equal(plan.isDeviceName('nul. '), true, 'trailing dots and spaces are ignored');
});

test('a clip named like a device still gets a name that is a file', () => {
  const out = plan.outputPath(posix.join(DIR, 'con.mp4'), DIR, '.mp4');
  assert.equal(plan.isDeviceName(out), false, out);
});
