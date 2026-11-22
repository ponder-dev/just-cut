'use strict';

/*
 * Boots the real window offscreen and checks it renders.
 *
 *   electron test/window.test.cjs [screenshot.png]
 *
 * This layer exists for what nothing else can catch: a preload that fails, a
 * policy blocking its own stylesheet, a footer that quietly lost its credit.
 * It also exercises the media scheme, because a protocol handler that will
 * stream any absolute path is a file read primitive, and the only proof it is
 * not one is watching it refuse.
 */

const { app, BrowserWindow, session, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// The real handlers and the real window options, so this checks the window
// main actually builds rather than one written here to make the test pass.
// Set before main is required, so main registers its handlers but leaves the
// window to this test.
process.env.JUST_TEST_NO_WINDOW = '1';
const main = require('../src/main.cjs');

// Clean-up never throws: on Windows a folder the app still holds (one just
// dropped on the window, say) cannot be deleted yet, and a throw here left
// the test waiting on its own time limit instead of finishing.
function tidy(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the system's temp clean-up */ }
}
// Anything thrown and not caught ends the test at once, saying what, instead
// of leaving it to wait on its time limit.
process.on('unhandledRejection', (err) => { console.error('\n  window test: ' + ((err && err.stack) || err)); app.exit(1); });
main.registerHandlers();

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
// A CI runner needs --no-sandbox, and Electron leaves its own switches in
// argv with the script path after them, so argv[2] is sometimes this file. It
// was, and taking it at its word would have written a PNG over this test.
// Anything starting with a dash, and this file itself, are not a screenshot.
const shot = process.argv.slice(2).find(
  (arg) => !arg.startsWith('-') && path.resolve(arg) !== __filename);
const problems = [];
// Groups whose window part could not run (no ffmpeg to make clips with).
const skipped = new Set();

// Every key the renderer is allowed to expect, and nothing else is promised.
const BRIDGE = [
  'pickVideos', 'pickFolder', 'folderButton', 'admitDropped', 'probe', 'thumbnail', 'chooseOutput', 'exportProject',
  'cancelExport', 'onExportProgress', 'onHistory', 'revealFile', 'openSite',
  'openLicences', 'skillText', 'openHowItWorks', 'fileUrl', 'version',
];

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

// One line per group of checks, so a log says which behaviour was looked at.
// A problem is filed under the first group whose pattern it matches; whatever
// matches none counts under "page, bridge, footer and the rest".
const GROUPS = [
  ['split', /^undo: (one file|the arrows|the split|after a split)/, ['undo']],
  ['undo and redo', /^undo:/, ['undo']],
  ['remove question', /^remove:/, ['undo']],
  ['tray', /^tray:|^folder drop: a dropped folder did not put|^folder drop: a folder with one clip/, ['undo', 'folder drop']],
  ['export failure', /^states: (a missing folder|after a failure|Settings is hidden after a failure|a long folder)/, ['states']],
  ['export done', /^states: (the export did not end|after an export|Settings is hidden after an export)/, ['states']],
  ['Copy skill', /Copy skill/, []],
  ['folder', /folder|^the note for one clip|^the link out|^a path that|^a clip found/i, ['folder drop']],
  ['cancel', /^cancel/, ['cancel']],
];
function reportGroups() {
  const left = problems.slice();
  const lines = GROUPS.map(([name, re, needs]) => {
    const mine = left.filter((p) => re.test(p));
    mine.forEach((p) => left.splice(left.indexOf(p), 1));
    const off = needs.find((k) => skipped.has(k));
    return `  ${mine.length ? 'FAIL' : off ? 'skipped (no ffmpeg)' : 'ok'}: ${name}`;
  });
  lines.push(`  ${left.length ? 'FAIL' : 'ok'}: page, bridge, footer and the rest`);
  console.log('window checks:\n' + lines.join('\n'));
}

/* --- checks that do not need a window ---------------------------------- */

// Undo and redo keys are caught in main, before the default Edit menu can
// answer Cmd+Z itself. Cmd on the Mac, Ctrl elsewhere, Ctrl+Y redo too.
function checkHistoryKeys() {
  const k = (key, mods, platform) => main.historyKey({ type: 'keyDown', key, ...mods }, platform);
  const cases = [
    [k('z', { meta: true }, 'darwin'), 'undo'],
    [k('Z', { meta: true, shift: true }, 'darwin'), 'redo'],
    [k('z', { control: true }, 'darwin'), null],
    [k('y', { meta: true }, 'darwin'), null],
    [k('z', { control: true }, 'win32'), 'undo'],
    [k('z', { control: true, shift: true }, 'linux'), 'redo'],
    [k('y', { control: true }, 'win32'), 'redo'],
    [k('z', { meta: true }, 'win32'), null],
    [k('z', {}, 'darwin'), null],
    [k('z', { meta: true, alt: true }, 'darwin'), null],
    [main.historyKey({ type: 'keyUp', key: 'z', meta: true }, 'darwin'), null],
  ];
  cases.forEach(([got, want], n) => {
    if (got !== want) problems.push(`history key case ${n + 1} gave ${got}, should be ${want}`);
  });
}

function checkWindowOptions() {
  const opts = main.WINDOW_OPTIONS;
  const web = opts.webPreferences || {};
  // The page background is #12131a, and a window that does not match it
  // flashes the old color on launch and shows it around the content while
  // the window is being resized.
  if (String(opts.backgroundColor).toLowerCase() !== '#12131a') {
    problems.push(`window backgroundColor is ${opts.backgroundColor}, should be #12131a`);
  }
  if (web.contextIsolation !== true) problems.push('contextIsolation must be on');
  if (web.nodeIntegration) problems.push('nodeIntegration must be off');
  // The reason the media scheme exists at all. Turning this off to let a
  // local page read local files is not a shortcut, it is removing the wall.
  if (web.webSecurity === false) problems.push('webSecurity is disabled, which the media scheme exists to avoid');
  if (!web.preload) problems.push('no preload, so the page would have no bridge at all');
}

function checkPolicy() {
  const file = path.join(RENDERER, 'index.html');
  if (!fs.existsSync(file)) return problems.push('src/renderer/index.html is missing');
  const html = fs.readFileSync(file, 'utf8');

  const meta = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i.exec(html);
  if (!meta) return problems.push('index.html has no Content-Security-Policy');
  // Matched on the quote it opened with, because a policy is full of the
  // other kind: "default-src 'none'" would otherwise be read as "default-src".
  const policy = (/content=(["'])([\s\S]*?)\1/i.exec(meta[0]) || [])[2] || '';

  if (/script-src[^;]*unsafe-(inline|eval)/i.test(policy)) {
    problems.push('the policy allows inline or eval scripts, which defeats it');
  }
  // The timeline plays the clips through the custom scheme, so the policy has
  // to say so or the video silently never loads.
  const media = /media-src([^;]*)/i.exec(policy) || /default-src([^;]*)/i.exec(policy);
  if (!media || !media[1].includes(`${main.MEDIA_SCHEME}:`)) {
    problems.push(`the policy does not allow ${main.MEDIA_SCHEME}:, so clips will not play. ` +
      `Add "media-src 'self' ${main.MEDIA_SCHEME}:;" to the meta in index.html`);
  }

  if (!fs.existsSync(path.join(RENDERER, 'licenses.html'))) {
    problems.push('licenses.html missing, run: node scripts/make-licenses.mjs');
  } else {
    // The credits screen is generated, so it is the page most likely to have
    // its policy quietly relaxed by an edit to the generator. It carried
    // unsafe-inline until its styles were moved into a file of their own.
    const credits = fs.readFileSync(path.join(RENDERER, 'licenses.html'), 'utf8');
    if (/unsafe-inline/.test(credits)) {
      problems.push('licenses.html asks for unsafe-inline. Its styles belong in licenses.css.');
    }
    if (!fs.existsSync(path.join(RENDERER, 'licenses.css'))) {
      problems.push('licenses.css missing, run: node scripts/make-licenses.mjs');
    }
  }
}

/* --- the media scheme --------------------------------------------------- */

async function checkMediaScheme() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-window-'));
  const clip = path.join(dir, 'picked.mp4');
  fs.writeFileSync(clip, Buffer.from('0123456789'));
  const stranger = path.join(dir, 'not-picked.mp4');
  fs.writeFileSync(stranger, Buffer.from('secret'));

  try {
    // Only what came back from the file dialog is servable, and this is the
    // one place that grants it.
    main.allowMedia([clip]);

    const served = await session.defaultSession.fetch(main.mediaUrl(clip));
    if (served.status !== 200) problems.push(`a picked clip was not served, got ${served.status}`);
    else if ((await served.text()) !== '0123456789') problems.push('the picked clip came back wrong');

    const ranged = await session.defaultSession.fetch(main.mediaUrl(clip), {
      headers: { Range: 'bytes=2-5' },
    });
    if (ranged.status !== 206) problems.push(`byte ranges are not answered, got ${ranged.status}, so scrubbing would crawl`);
    else if ((await ranged.text()) !== '2345') problems.push('a byte range came back with the wrong bytes');

    for (const forbidden of [stranger, '/etc/hosts', path.join(dir, '..', path.basename(dir), 'not-picked.mp4')]) {
      const refused = await session.defaultSession.fetch(main.mediaUrl(forbidden));
      if (refused.status !== 403 && refused.status !== 404) {
        problems.push(`the media scheme served ${forbidden} with ${refused.status}, which makes it a file read primitive`);
      }
    }
  } catch (err) {
    problems.push('media scheme: ' + err.message);
  } finally {
    tidy(dir);
  }
}

/* --- folders ------------------------------------------------------------ */

// Choosing a folder is choosing the clips inside it, and nothing else. Main
// walks the folder itself and admits exactly what the walk found: never the
// folder's own path, never a path outside it, never what the walk passed over
// (hidden files, other kinds of file, a link that leads out of the folder).
async function checkFolderSecurity() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-folder-'));
  const folder = path.join(root, 'Holiday');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  for (const f of ['a.mp4', 'sub/b.MOV', '.hidden.mp4', 'notes.txt']) fs.writeFileSync(path.join(folder, f), 'x');
  const outside = path.join(root, 'outside.mp4');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(folder, 'link-out.mp4'));
  const sibling = path.join(root, 'Holiday 2');
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'near.mp4'), 'secret');
  try {
    const got = await main.gatherChosen([folder]);
    const rel = got.paths.map((p) => path.relative(folder, p).split(path.sep).join('/')).sort().join(', ');
    if (rel !== 'a.mp4, sub/b.MOV') problems.push('a folder gave ' + rel + ', not its videos');
    if (got.folders !== 1 || got.name !== 'Holiday') problems.push('a folder was not named: ' + JSON.stringify({ f: got.folders, n: got.name }));
    if (got.skipped !== 1) problems.push('the link out of the folder was not passed over: skipped ' + got.skipped);
    const status = async (p) => (await session.defaultSession.fetch(main.mediaUrl(p))).status;
    if (await status(path.join(folder, 'a.mp4')) !== 200) problems.push('a clip found in a chosen folder cannot be read');
    for (const [what, p] of [
      ['a file outside the folder', outside],
      ['a file beside the folder', path.join(sibling, 'near.mp4')],
      ['a path out of the folder by ..', path.join(folder, '..', 'outside.mp4')],
      ['the folder itself', folder],
      ['a hidden file inside it', path.join(folder, '.hidden.mp4')],
      ['a link out of it', path.join(folder, 'link-out.mp4')],
      ['a file of another kind', path.join(folder, 'notes.txt')],
    ]) {
      const code = await status(p);
      if (code !== 403 && code !== 404) problems.push(`choosing a folder let the page read ${what} (${code})`);
    }
    // Naming a folder together with a path that was not found in it admits
    // that path only as a file named on its own, never by being inside.
    const none = await main.gatherChosen([path.join(root, 'missing')]);
    if (none.paths.length) problems.push('a path that is not there was admitted');
  } catch (err) {
    problems.push('folder security: ' + err.message);
  } finally {
    tidy(root);
  }
}

// A real folder dropped through Chromium's own drop path, the one a drag from
// Finder or Explorer takes. Its clips land in the tray, one folder with one
// clip goes to the tray too, and the window says how many it added.
async function checkFolderDrop(win) {
  let ffmpeg;
  try {
    ffmpeg = require('../src/binaries.cjs').resolve('ffmpeg', [path.join(__dirname, '..', 'vendor', 'ffmpeg')]);
  } catch (e) {
    skipped.add('folder drop'); console.log('folder drop: skipped, no ffmpeg to make clips with');
    return;
  }
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-drop-'));
  const make = (file) => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10',
    '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  const holiday = path.join(root, 'Holiday');
  const solo = path.join(root, 'Solo');
  fs.mkdirSync(path.join(holiday, 'sub'), { recursive: true });
  fs.mkdirSync(solo);
  make(path.join(holiday, 'a.mp4'));
  make(path.join(holiday, 'b.mp4'));
  make(path.join(holiday, 'sub', 'c.mp4'));
  fs.writeFileSync(path.join(holiday, 'broken.mp4'), 'not a video');
  fs.writeFileSync(path.join(holiday, 'notes.txt'), 'hello');
  make(path.join(solo, 'only.mp4'));
  const js = (code) => win.webContents.executeJavaScript(code);
  const dropOn = async (target) => {
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.sendCommand('Input.dispatchDragEvent', { type, x: 360, y: 300, data: { items: [], files: [target], dragOperationsMask: 1 } });
    }
    cdp.detach();
    return js(`(async () => {
      for (let i = 0; i < 80 && document.getElementById('editor').hidden; i++) await new Promise((r) => setTimeout(r, 100));
      for (let i = 0; i < 80 && document.querySelector('#tray-list .pending'); i++) await new Promise((r) => setTimeout(r, 100));
      return {
        editor: !document.getElementById('editor').hidden,
        tray: [...document.querySelectorAll('#tray-list .tray-row')].length,
        timeline: document.querySelectorAll('#track .clip').length,
        note: document.getElementById('tray-hint').textContent,
        error: document.getElementById('error').hidden ? '' : document.getElementById('error').textContent,
        startError: document.querySelector('#start .k-error').textContent,
      };
    })()`);
  };
  try {
    const got = await dropOn(holiday);
    if (!got.editor || got.tray !== 3 || got.timeline !== 0) problems.push('a dropped folder did not put its 3 clips in the tray: ' + JSON.stringify(got));
    if (got.note !== 'Added 3 clips from Holiday, skipped 1 it could not open') problems.push('the window did not say what a folder added: ' + JSON.stringify(got.note));
    const names = await js(`[...document.querySelectorAll('#tray-list .tray-row')].map((r) => r.textContent).join('|')`);
    if (!/a\.mp4.*b\.mp4.*c\.mp4/.test(names)) problems.push('the folder\'s clips are not in the intake order: ' + names);

    await win.loadFile(path.join(RENDERER, 'index.html'));
    await new Promise((r) => setTimeout(r, 800));
    const one = await dropOn(solo);
    if (!one.editor || one.tray !== 1 || one.timeline !== 0) problems.push('a folder with one clip should go to the tray, not the timeline: ' + JSON.stringify(one));
    if (one.note !== 'Added 1 clip from Solo') problems.push('the note for one clip was ' + JSON.stringify(one.note));
  } catch (err) {
    problems.push('folder drop: ' + err.message);
  } finally {
    await win.loadFile(path.join(RENDERER, 'index.html'));
    await new Promise((r) => setTimeout(r, 500));
    tidy(root);
  }
}

/* --- where the Open window starts --------------------------------------- */

// Windows starts an Open window in Downloads, usually empty, unless told
// otherwise. The first one should start in Documents and every later one
// where the last file came from. The real dialog is swapped for one that
// records what it was asked and answers with a file, then put back.
async function checkOpenFolder(win) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-open-'));
  const clip = path.join(dir, 'picked.mp4');
  fs.writeFileSync(clip, Buffer.from('0'));
  const real = dialog.showOpenDialog;
  const asked = [];
  dialog.showOpenDialog = async (...args) => {
    asked.push(args[args.length - 1].defaultPath);
    return { canceled: false, filePaths: [clip] };
  };
  try {
    await win.webContents.executeJavaScript('window.justcut.pickVideos()');
    await win.webContents.executeJavaScript('window.justcut.pickVideos()');
    if (asked[0] !== app.getPath('documents')) {
      problems.push(`the first Open window starts in ${asked[0]}, not Documents`);
    }
    if (asked[1] !== dir) {
      problems.push(`the next Open window starts in ${asked[1]}, not ${dir} where the last file came from`);
    }
  } catch (err) {
    problems.push('open folder: ' + err.message);
  } finally {
    dialog.showOpenDialog = real;
    tidy(dir);
  }
}

/* Split, then undo, then redo, then the trash can's question, in the real page with a real clip (walk,
   2026-11-16: a split taken back left both pieces behind). The clip is made
   here with the bundled ffmpeg; without one, this part says so and skips. */
async function checkUndo(win) {
  let ffmpeg;
  try {
    ffmpeg = require('../src/binaries.cjs').resolve('ffmpeg', [path.join(__dirname, '..', 'vendor', 'ffmpeg')]);
  } catch (e) {
    skipped.add('undo'); console.log('undo: skipped, no ffmpeg to make a clip with');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-undo-'));
  const clip = path.join(dir, 'four seconds.mp4');
  require('node:child_process').execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=25', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', clip]);
  const real = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [clip] });
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () => js(`(() => ({
    blocks: [...document.querySelectorAll('#track .clip .clip-facts')].map((n) => n.textContent).join(' | '),
    undo: !document.getElementById('undo').disabled,
    redo: !document.getElementById('redo').disabled,
  }))()`);
  try {
    // One file goes straight onto the timeline (walk, 2026-11-16); two
    // or more wait in the tray.
    await js("document.getElementById('browse').click()");
    for (let n = 0; n < 50 && !(await state()).blocks; n++) await wait(100);
    const before = await state();
    if (!before.blocks) return problems.push('undo: one file added did not land on the timeline');
    if (await js("document.querySelectorAll('#tray-list .tray-row').length")) problems.push('tray: one file went to the tray, not the timeline');
    if (before.undo || before.redo) problems.push('undo: the arrows are lit before any change');

    await js(`(() => { const r = document.getElementById('scrub'); r.value = '1000';
      r.dispatchEvent(new Event('input')); document.getElementById('split').click(); })()`);
    await wait(200);
    const split = await state();
    if (split.blocks.split(' | ').length !== 2) problems.push('undo: the split did not make two blocks: ' + split.blocks);
    if (!split.undo || split.redo) problems.push('undo: after a split, undo should be lit and redo dark');

    await js("document.getElementById('undo').click()");
    await wait(200);
    const undone = await state();
    if (undone.blocks !== before.blocks) {
      problems.push(`undo: after undoing the split the timeline is "${undone.blocks}", should be "${before.blocks}"`);
    }
    if (!undone.redo) problems.push('undo: redo is not lit after an undo');

    await js("document.getElementById('redo').click()");
    await wait(200);
    const redone = await state();
    if (redone.blocks !== split.blocks) {
      problems.push(`undo: after redo the timeline is "${redone.blocks}", should be "${split.blocks}"`);
    }

    // The trash can asks before removing, and Cancel keeps the clip.
    await js("localStorage.removeItem('justcut.settings')");
    await js("document.querySelector('#track .clip .clip-trash').click()");
    await wait(200);
    const asked = await js("document.getElementById('ask-remove').open");
    if (!asked) problems.push('remove: the trash can removed without asking');
    await js("document.getElementById('ask-remove-cancel').click()");
    await wait(200);
    if ((await state()).blocks !== redone.blocks) problems.push('remove: Cancel did not keep the clip');
    await js("document.querySelector('#track .clip .clip-trash').click()");
    await wait(200);
    await js("document.getElementById('ask-remove-yes').click()");
    await wait(200);
    if ((await state()).blocks.split(' | ').length !== 1) problems.push('remove: Remove did not take the clip off');

    await js("document.getElementById('clear').click()");
  } catch (err) {
    problems.push('undo: ' + err.message);
  } finally {
    dialog.showOpenDialog = real;
    tidy(dir);
  }
}

/* --- the export's states, the veil, the carried setting ---------------- */

function checkExportWords() {
  const said = main.plainExportError(new Error('[out#0/mp4 @ 0x7f] Error opening output file /x/y.mp4: No space left on device\nConversion failed!'), '/x/y.mp4');
  if (!/no space left on device/i.test(said)) problems.push('export words: the cause was dropped: ' + said);
  if (/Conversion failed|@ 0x/.test(said)) problems.push('export words: ffmpeg\'s own wording got through: ' + said);
  if (!/^Just Cut could not finish y\.mp4: /.test(said)) problems.push('export words: the file is not named: ' + said);
}

// A build from before the kit kept "Don't ask again" under its own key: the
// first launch of this one carries it over, once.
async function checkOldSetting(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const reload = async () => { await win.loadFile(path.join(RENDERER, 'index.html')); await new Promise((r) => setTimeout(r, 700)); };
  await js("localStorage.removeItem('justcut.settings'); localStorage.setItem('justcut.removeWithoutAsking', '1')");
  await reload();
  const saved = await js("JSON.parse(localStorage.getItem('justcut.settings') || '{}')");
  if (saved.removeWithoutAsking !== true) problems.push("old setting: an earlier build's Don't ask again was not carried over: " + JSON.stringify(saved));
  await js("localStorage.removeItem('justcut.settings'); localStorage.removeItem('justcut.removeWithoutAsking')");
  await reload();
}

async function checkStatesAndVeil(win) {
  let ffmpeg;
  try {
    ffmpeg = require('../src/binaries.cjs').resolve('ffmpeg', [path.join(__dirname, '..', 'vendor', 'ffmpeg')]);
  } catch (e) {
    skipped.add('states'); console.log('states: skipped, no ffmpeg to make a clip with');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-states-'));
  const clip = path.join(dir, 'one second.mp4');
  require('node:child_process').execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=160x120:rate=10', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', clip]);
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reload = async () => { await win.loadFile(path.join(RENDERER, 'index.html')); await wait(700); };
  const realOpen = dialog.showOpenDialog;
  const realSave = dialog.showSaveDialog;
  try {
    // A file held over the window lights the start zone and shows the veil.
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    // Aimed at the drop zone itself: a runner's screen can be smaller than
    // the window asks for, and a fixed point then lands outside the zone.
    const at = await js(`(() => { const z = document.querySelector('#start .k-zone'); z.scrollIntoView({ block: 'center' }); const r = z.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await cdp.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', x: at.x, y: at.y, data: { items: [], files: [clip], dragOperationsMask: 1 } });
    await wait(150);
    const held = await js(`({
      veil: [...document.querySelectorAll('.k-veil')].some((v) => !v.hidden && v.querySelector('svg')),
      zone: !!document.querySelector('#start .k-zone.over'),
    })`);
    await cdp.sendCommand('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data: { items: [], files: [], dragOperationsMask: 0 } }).catch(() => {});
    cdp.detach();
    if (!held.veil) problems.push('veil: a file held over the window shows no veil with its icon');
    if (!held.zone) problems.push('veil: the start zone did not light while a file was held over the window');
    await reload();

    // A finished export has its card's Start again and no second one; a
    // failed one has only Try again, so Start again stays; both keep Settings.
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [clip] });
    await js("document.getElementById('browse').click()");
    for (let n = 0; n < 50 && !(await js("document.querySelectorAll('#track .clip').length")); n++) await wait(100);
    const heights = await js(`(() => { const h = (id) => document.getElementById(id).getBoundingClientRect().height;
      return { undo: h('undo'), redo: h('redo'), help: h('help'), split: h('split') }; })()`);
    if (heights.undo !== heights.redo || heights.undo > heights.split) {
      problems.push('toolbar: the arrows are ' + JSON.stringify(heights) + ', taller than the text buttons');
    }
    // A short window (an 800x600 screen leaves about 520 for the page, and
    // the window gives up its least size to fit): Export stays in view at the
    // foot of the side column (decided 2026-11-20).
    {
      const was = win.getContentSize();
      const least = win.getMinimumSize();
      win.setMinimumSize(320, 320);
      // two columns on a laptop, one column at its least width and on an 800 wide screen
      for (const [w, h] of [[1100, 520], [900, 520], [800, 520]]) {
        win.setContentSize(w, h);
        await wait(400);
        const small = await js(`(() => { const b = document.getElementById('go').getBoundingClientRect();
          return { top: Math.round(b.top), bottom: Math.round(b.bottom), right: Math.round(b.right), h: innerHeight, w: innerWidth, shown: !!document.getElementById('go').offsetParent }; })()`);
        if (!small.shown || small.top < 0 || small.bottom > small.h || small.right > small.w) problems.push(`a short window (${w}x${h}): Export is out of view: ` + JSON.stringify(small));
      }
      win.setMinimumSize(...least);
      win.setContentSize(...was);
      await wait(300);
    }
    const view = () => js(`(() => {
      const vis = (n) => !!n && !n.hidden && n.getClientRects().length > 0;
      const card = document.getElementById('run');
      return {
        startAgain: vis(document.getElementById('clear')),
        settings: vis(document.querySelector('#mini-settings summary')),
        cardAgain: vis(document.getElementById('again')),
        wide: card.scrollWidth > card.clientWidth + 1 || document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        text: card.textContent,
      };
    })()`);

    const out = path.join(dir, 'made.mp4');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
    await js("document.getElementById('go').click()");
    for (let n = 0; n < 100 && !fs.existsSync(out); n++) await wait(100);
    await wait(500);
    const done = await view();
    if (!/Done/.test(done.text)) problems.push('states: the export did not end on Done: ' + done.text);
    if (done.startAgain || !done.cardAgain) problems.push('states: after an export there should be one Start again, on the card: ' + JSON.stringify(done));
    if (!done.settings) problems.push('states: Settings is hidden after an export');

    const longDir = path.join(dir, 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60));
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(longDir, 'nope.mp4') });
    await js("document.getElementById('go').click()");
    await wait(1200);
    const failed = await view();
    if (!/not there any more/.test(failed.text)) problems.push('states: a missing folder was not said in words: ' + failed.text);
    if (!failed.startAgain) problems.push('states: after a failure Start again is gone: ' + JSON.stringify(failed));
    if (!failed.settings) problems.push('states: Settings is hidden after a failure');
    if (failed.wide) problems.push('states: a long folder path runs off the failed card');
  } catch (err) {
    problems.push('states: ' + err.message);
  } finally {
    dialog.showOpenDialog = realOpen;
    dialog.showSaveDialog = realSave;
    try { win.webContents.debugger.detach(); } catch { /* not attached */ }
    await win.loadFile(path.join(RENDERER, 'index.html'));
    await wait(500);
    tidy(dir);
  }
}

/* --- Cancel in the real window ------------------------------------------ */

// Pressed at "Getting started" (before ffmpeg runs) and again while the
// encode is under way, on a clip long enough to still be encoding. Each time
// the card must say Stopped, no ffmpeg may be left running, and neither a part
// file nor an export may be left in the folder. (A Linux tester pressed Cancel
// and the export carried on to Done, 3 times of 3.)
async function checkCancel(win) {
  let ffmpeg;
  try {
    ffmpeg = require('../src/binaries.cjs').resolve('ffmpeg', [path.join(__dirname, '..', 'vendor', 'ffmpeg')]);
  } catch (e) {
    skipped.add('cancel'); console.log('cancel: skipped, no ffmpeg to make a clip with');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justcut-cancel-'));
  const clip = path.join(dir, 'long.mp4');
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const realOpen = dialog.showOpenDialog;
  const realSave = dialog.showSaveDialog;
  const stray = () => fs.readdirSync(dir).filter((f) => f !== 'long.mp4');
  const encoders = () => {
    try { return require('node:child_process').execFileSync('pgrep', ['-f', dir]).toString().trim().split('\n').filter(Boolean).length; } catch { return 0; }
  };
  try {
    // Busy to read and to encode: noise does not compress, so it keeps ffmpeg working.
    require('node:child_process').execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc2=size=1280x720:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '120',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', clip]);
    await win.loadFile(path.join(RENDERER, 'index.html'));
    await wait(700);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [clip] });
    await js("document.getElementById('browse').click()");
    for (let n = 0; n < 100 && !(await js("document.querySelectorAll('#track .clip').length")); n++) await wait(100);
    for (const phase of ['start', 'encoding']) {
      const out = path.join(dir, phase + '.mp4');
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
      await js("document.getElementById('go').click()");
      if (phase === 'encoding') {
        for (let n = 0; n < 600 && !stray().some((f) => f.endsWith('.part.mp4')); n++) await wait(50);
        if (!stray().some((f) => f.endsWith('.part.mp4'))) { problems.push('cancel: the encode never started'); break; }
      } else {
        await wait(50);
      }
      const t0 = Date.now();
      await js("document.getElementById('cancel').click()");
      let text = '';
      for (let n = 0; n < 60; n++) {
        text = await js("document.getElementById('run').textContent");
        if (/Stopped|Done/.test(text)) break;
        await wait(50);
      }
      const took = Date.now() - t0;
      if (!/Stopped/.test(text)) problems.push('cancel (' + phase + '): the card did not say Stopped: ' + text);
      if (took > 3000) problems.push('cancel (' + phase + '): it took ' + took + ' ms to stop');
      await wait(300);
      if (stray().length) problems.push('cancel (' + phase + '): left behind ' + stray().join(', '));
      if (process.platform !== 'win32' && encoders()) problems.push('cancel (' + phase + '): ffmpeg is still running');
      if (!(await js("!document.getElementById('go').disabled"))) problems.push('cancel (' + phase + '): Export stayed disabled');
    }
  } catch (err) {
    problems.push('cancel: ' + err.message);
  } finally {
    dialog.showOpenDialog = realOpen;
    dialog.showSaveDialog = realSave;
    if (!win.isDestroyed()) { await win.loadFile(path.join(RENDERER, 'index.html')); await wait(500); }
    tidy(dir);
  }
}

/* --- the window --------------------------------------------------------- */

app.whenReady().then(async () => {
  main.serveMedia();

  checkWindowOptions();
  checkHistoryKeys();
  checkPolicy();
  await checkMediaScheme();

  const win = new BrowserWindow({
    ...main.WINDOW_OPTIONS,
    show: false,
    webPreferences: { ...main.WINDOW_OPTIONS.webPreferences, offscreen: true },
  });
  // Dressed as main dresses every window: the title strip on Windows and Linux.
  require('../src/kit/window.cjs').dress(win);

  if (win.getBackgroundColor().toLowerCase() !== '#12131a') {
    problems.push(`the window came up ${win.getBackgroundColor()}, not #12131a`);
  }

  // Electron 35 moved the details onto the event. Read either shape, so this
  // keeps working across an upgrade rather than silently catching nothing.
  win.webContents.on('console-message', (...received) => {
    const first = received[0];
    const detail = first && typeof first === 'object' && 'level' in first
      ? first
      : { level: received[1], message: received[2] };
    const level = String(detail.level);
    if (level === 'error' || level === 'warning' || Number(level) >= 2) {
      problems.push('console: ' + detail.message);
    }
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    problems.push(`preload ${file}: ${err.message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, why) => {
    problems.push(`the page did not load: ${why} (${code})`);
  });

  await win.loadFile(path.join(RENDERER, 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const checks = await win.webContents.executeJavaScript(`(() => {
    const bridge = window.justcut || {};
    const site = document.getElementById('site');
    const licences = document.getElementById('licences');
    return {
      bridgeIsThere: typeof window.justcut === 'object' && window.justcut !== null,
      missing: ${JSON.stringify(BRIDGE)}.filter((k) => k !== 'version' && k !== 'folderButton' && typeof bridge[k] !== 'function'),
      version: bridge.version,
      footerText: (document.querySelector('footer') || {}).textContent || '',
      footerOrder: [...(document.querySelector('footer') || { children: [] }).children].map((n) => n.className),
      startVersion: (document.querySelector('.k-start-head .k-version') || {}).textContent || null,
      extra: Object.keys(bridge).filter((k) => !${JSON.stringify(BRIDGE)}.includes(k)),
      mediaUrl: typeof bridge.fileUrl === 'function' ? bridge.fileUrl('/tmp/a b.mp4') : null,
      node: typeof window.require + '/' + typeof window.process,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
      hasFooter: !!document.querySelector('footer'),
      siteText: site ? site.innerText.replace(/\\s+/g, ' ').trim() : null,
      licencesText: licences ? licences.innerText.replace(/\\s+/g, ' ').trim() : null,
      licencesFirst: site && licences
        ? !!(licences.compareDocumentPosition(site) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false,
      inFooter: !!(site && site.closest('footer')) && !!(licences && licences.closest('footer')),
      title: document.title,
      // Chromium's own ring is all but invisible on this dark panel. Read as
      // the shorthand: with a var() in it the longhands read back empty.
      focusRing: [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) =>
        rule.selectorText === ':focus-visible' && /solid/.test(rule.style.getPropertyValue('outline')))),
    };
  })()`);

  if (!checks.bridgeIsThere) problems.push('the preload did not expose window.justcut at all');
  if (checks.missing.length) problems.push('the bridge is missing: ' + checks.missing.join(', '));
  if (checks.extra.length) problems.push('the bridge exposes more than it promised: ' + checks.extra.join(', '));
  const pkgVersion = require('../package.json').version;
  if (checks.version !== pkgVersion) problems.push(`the bridge's version is ${checks.version}, package.json says ${pkgVersion}`);
  // The version is at the top only (decided 2026-11-20); the footer is licences, promise, credit.
  if (checks.footerText.includes(pkgVersion)) problems.push('the footer still shows the version: ' + checks.footerText);
  if (checks.footerOrder.join(' ') !== 'k-footer-licences k-footer-promise k-footer-credit') problems.push('the footer is not licences, promise, credit: ' + checks.footerOrder.join(' '));
  // A pre-release build says so beside its coming version (decided 2026-11-20).
  const label = /-/.test(pkgVersion) ? `${pkgVersion.split('-')[0]} (pre-release)` : pkgVersion;
  if (checks.startVersion !== label) problems.push('the start screen does not show ' + label + ': ' + checks.startVersion);
  // The title strip: under the traffic lights on a Mac; on Windows and Linux
  // the app's own dark title bar, the system buttons' height, with the
  // window's name in it (the kit's frame, decided 2026-11-20).
  const strip = await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.titlebar'); const n = t && t.querySelector('.k-titlebar-name');
    return t ? { h: t.offsetHeight, name: n ? n.textContent : null, title: document.title } : null; })()`);
  if (process.platform === 'darwin') { if (!strip || strip.h !== 28 || strip.name !== null) problems.push('the title strip on a Mac: ' + JSON.stringify(strip)); }
  else if (!strip || strip.h !== 32 || !strip.title || strip.name !== strip.title) problems.push(`the title bar on ${process.platform}: ${JSON.stringify(strip)}`);
  if (checks.node !== 'undefined/undefined') problems.push('node leaked into the page: ' + checks.node);
  if (!/^justcut-media:\/\//.test(String(checks.mediaUrl))) {
    problems.push('fileUrl does not return a media scheme URL: ' + checks.mediaUrl);
  }
  if (String(checks.mediaUrl).includes(' ')) problems.push('fileUrl left a space unencoded, so paths with spaces will not play');

  // A stylesheet that did not apply is the usual sign of a policy blocking
  // its own assets, so this reads a computed value rather than looking for
  // the tag, which would be there either way.
  if (checks.bodyBackground === 'rgba(0, 0, 0, 0)') {
    problems.push('the stylesheet did not apply, check the Content Security Policy');
  }
  if (!checks.accent) problems.push('--accent is not set, so the house palette is not loaded');
  if (!checks.radius) problems.push('--radius is not set, so the house palette is not loaded');

  if (!checks.hasFooter) problems.push('there is no footer, and the footer is not optional');
  if (!checks.inFooter) problems.push('the two footer controls are not in the footer');
  if (!/^Powered by PonderDev$/.test(String(checks.siteText))) {
    problems.push('the PonderDev credit is wrong or missing: ' + checks.siteText);
  }
  if (!/^Licences and credits$/.test(String(checks.licencesText))) {
    problems.push('the licences control is wrong or missing: ' + checks.licencesText);
  }
  if (!checks.licencesFirst) problems.push('the footer controls are the wrong way round: the licences go on the left, the credit on the right');
  if (!checks.focusRing) problems.push('no :focus-visible outline, so a keyboard user cannot see where they are');

  // The kit's start block, the skill line's text, and the family's footer.
  const kit = await win.webContents.executeJavaScript(`(async () => {
    let skill = '';
    try { skill = await window.justcut.skillText(); } catch (e) { skill = 'error: ' + e.message; }
    const foot = document.querySelector('footer');
    return {
      startBlock: !!document.querySelector('#start.k-start .k-zone') && !document.getElementById('start').hidden,
      chooseIsBrowse: !!document.querySelector('#start .k-zone #browse'),
      skillLine: !!document.querySelector('#start .k-skill'),
      skill: skill.slice(0, 40),
      promise: (foot && foot.querySelector('.k-footer-promise') || {}).textContent || null,
      inlineSvg: document.querySelectorAll('svg:not(.k-icon)').length,
    };
  })()`);
  if (!kit.startBlock) problems.push('the start screen is not the kit start block');
  if (!kit.chooseIsBrowse) problems.push('the start block has no Choose videos button with the id browse');
  if (!kit.skillLine) problems.push('the start block has no skill line');
  if (!/^---\r?\nname: justcut\r?\n/.test(kit.skill)) problems.push('skillText did not hand back the shipped SKILL.md: ' + kit.skill);
  if (kit.promise !== 'Nothing is uploaded, and your originals are never touched.') problems.push('the footer does not say the family promise: ' + kit.promise);
  if (kit.inlineSvg) problems.push(kit.inlineSvg + ' icon(s) on the page not from the kit set');

  // Copy skill is pressed, not only read: the app denies every permission, and
  // the clipboard write asks for one, so a read-only check passed while the
  // button said "Could not copy".
  // A hidden window is never focused, and the clipboard refuses an unfocused
  // page, so the test has Chromium treat the page as focused.
  win.webContents.debugger.attach();
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const copied = await win.webContents.executeJavaScript(`(async () => {
    const b = [...document.querySelectorAll('#start .k-skill button')].find((x) => /^Copy skill$/.test(x.textContent.trim()));
    if (!b) return 'no Copy skill button';
    b.click();
    for (let n = 0; n < 20 && b.textContent.trim() === 'Copy skill'; n++) await new Promise((r) => setTimeout(r, 100));
    return b.textContent.trim();
  })()`, true);
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
  win.webContents.debugger.detach();
  if (copied !== 'Copied') problems.push('pressing Copy skill did not copy: the button said ' + JSON.stringify(copied));

  await checkOpenFolder(win);
  await checkFolderSecurity();
  await checkFolderDrop(win);
  await checkUndo(win);
  checkExportWords();
  await checkStatesAndVeil(win);
  await checkCancel(win);
  await checkOldSetting(win);

  if (shot) fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());

  reportGroups();
  console.log(problems.length
    ? 'PROBLEMS:\n  ' + problems.join('\n  ')
    : 'window ok: ' + JSON.stringify(checks));
  app.exit(problems.length ? 1 : 0);
});

// Generous: the Windows test machine runs x64 under emulation, where making
// and exporting the long cancel clip takes several times as long as on a Mac.
setTimeout(() => { console.error('timed out'); app.exit(2); }, 180000);
