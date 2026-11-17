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
main.registerHandlers();

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
// A CI runner needs --no-sandbox, and Electron leaves its own switches in
// argv with the script path after them, so argv[2] is sometimes this file. It
// was, and taking it at its word would have written a PNG over this test.
// Anything starting with a dash, and this file itself, are not a screenshot.
const shot = process.argv.slice(2).find(
  (arg) => !arg.startsWith('-') && path.resolve(arg) !== __filename);
const problems = [];

// Every key the renderer is allowed to expect, and nothing else is promised.
const BRIDGE = [
  'pickVideos', 'admitDropped', 'probe', 'thumbnail', 'chooseOutput', 'exportProject',
  'cancelExport', 'onExportProgress', 'onHistory', 'revealFile', 'openSite',
  'openLicences', 'fileUrl',
];

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

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
    fs.rmSync(dir, { recursive: true, force: true });
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
    fs.rmSync(dir, { recursive: true, force: true });
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
    console.log('undo: skipped, no ffmpeg to make a clip with');
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
    await js("localStorage.removeItem('justcut.removeWithoutAsking')");
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
    fs.rmSync(dir, { recursive: true, force: true });
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
      missing: ${JSON.stringify(BRIDGE)}.filter((k) => typeof bridge[k] !== 'function'),
      extra: Object.keys(bridge).filter((k) => !${JSON.stringify(BRIDGE)}.includes(k)),
      mediaUrl: typeof bridge.fileUrl === 'function' ? bridge.fileUrl('/tmp/a b.mp4') : null,
      node: typeof window.require + '/' + typeof window.process,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
      hasFooter: !!document.querySelector('footer'),
      siteText: site ? site.innerText.replace(/\\s+/g, ' ').trim() : null,
      licencesText: licences ? licences.innerText.replace(/\\s+/g, ' ').trim() : null,
      siteFirst: site && licences
        ? !!(site.compareDocumentPosition(licences) & Node.DOCUMENT_POSITION_FOLLOWING)
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
  if (!checks.siteFirst) problems.push('the footer controls are the wrong way round, credit comes first');
  if (!checks.focusRing) problems.push('no :focus-visible outline, so a keyboard user cannot see where they are');

  await checkOpenFolder(win);
  await checkUndo(win);

  if (shot) fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());

  console.log(problems.length
    ? 'PROBLEMS:\n  ' + problems.join('\n  ')
    : 'window ok: ' + JSON.stringify(checks));
  app.exit(problems.length ? 1 : 0);
});

setTimeout(() => { console.error('timed out'); app.exit(2); }, 30000);
