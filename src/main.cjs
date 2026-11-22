'use strict';

/*
 * Just Cut: cut a video down and put the pieces in order.
 *
 * This file is only wiring. plan.js decides, engine.cjs does the ffmpeg work,
 * and neither of them knows anything about Electron, so both run from a plain
 * node script and the command line is a wrapper rather than a second app.
 *
 * Two rules hold throughout. The clips you pick are only ever read, and the
 * app never touches the network: no updater, no telemetry, no version check.
 * The only thing that can leave this machine is a browser being told to open
 * one of two fixed ponderdev.com addresses (the site, and the start screen's
 * "How it works"), each from its own handler that takes no arguments.
 */

const { app, BrowserWindow, screen, ipcMain, dialog, shell, protocol, session } = require('electron');

const path = require('node:path');

// The tool's own version, from its package.json. Not app.getVersion(): run by
// a test or a harness, Electron reports its own version instead.
const APP_VERSION = (() => {
  try { return require(path.join(__dirname, '..', 'package.json')).version; } catch (e) { return app.getVersion(); }
})();
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');

const engine = require('./engine.cjs');
const plan = require('./plan.js');
const binaries = require('./binaries.cjs');
// The family's folder intake, one copy for every tool (kit-sync writes it).
const { scan } = require('./kit/scan.cjs');
// The frame: a dark title bar of the app's own on Windows and Linux, the traffic lights on a Mac.
const { frame, dress } = require('./kit/window.cjs');

let win = null;
let licenceWindow = null;
let running = null;
// Set when someone quits mid-export, so the quit waits for ffmpeg to stop and
// its part file to be deleted instead of leaving both behind.
let quitAfterExport = false;
// Where the last file came from, so the next Open window starts there. Left
// to itself, Windows starts an Open window in Downloads, which is usually
// empty and filtered to nothing.
let lastOpenDir = null;

/* --- the bundled binaries --------------------------------------------- */

function vendorDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg')
    : path.join(__dirname, '..', 'vendor', 'ffmpeg');
}

// The app must never fall back to a system ffmpeg: someone who downloaded a
// finished app should not discover it needs a video encoder installing. The
// command line is the opposite and does fall back, which is why the two share
// a resolver with a flag rather than each having their own.
function binary(name) {
  return binaries.resolve(name, [vendorDir()], false);
}

/* --- serving the clips to the page ------------------------------------ */

/*
 * A timeline has to show the footage, and the page is loaded from disk, so
 * something has to bridge the two. The tempting shortcut is webSecurity:
 * false, which lets any page read any file and is not a shortcut, it is
 * turning the wall off. Instead there is one scheme, and it serves exactly
 * the files the person using the app picked in the file dialog.
 *
 * The allowlist is the whole point. A protocol handler that will stream any
 * absolute path is a file read primitive dressed up as a convenience, so this
 * one resolves symlinks at both ends and refuses anything it was not handed.
 */
const MEDIA_SCHEME = 'justcut-media';
const allowed = new Set();

// Registered before the app is ready, which is the only time this can happen.
// standard so relative URLs and origins behave, secure so the page is not
// downgraded to mixed content, supportFetchAPI and stream so a <video> can
// ask for byte ranges and seek.
protocol.registerSchemesAsPrivileged([{
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

const MEDIA_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

/** Add picked files to the set the media scheme will serve. */
function allowMedia(paths) {
  for (const p of paths) {
    try {
      allowed.add(fs.realpathSync(path.resolve(p)));
    } catch (err) {
      // A file that cannot be resolved cannot be served either, so there is
      // nothing to record and nothing to report: the probe will say why.
    }
  }
  return paths;
}

/** Throws unless every path came out of the file dialog. */
function requireAllowed(paths) {
  for (const p of paths) {
    let real;
    try {
      real = fs.realpathSync(path.resolve(p));
    } catch (err) {
      throw new Error(`Cannot read ${path.basename(String(p))}`);
    }
    if (!allowed.has(real)) throw new Error('That file was not one you chose, so it will not be opened');
  }
}

function mediaUrl(file) {
  // Kept in the query rather than the path because a standard scheme
  // normalises its path, and a Windows path or one containing ".." must
  // survive the round trip byte for byte.
  return `${MEDIA_SCHEME}://clip/?p=${encodeURIComponent(file)}`;
}

/**
 * Answers the media scheme, with byte ranges, so the timeline can scrub.
 * Called once the app is ready. Exported so the window test registers the
 * same handler the app uses rather than a stand-in written to pass.
 */
function serveMedia() {
  // Nothing in this app wants a camera, a microphone, a notification or a
  // location, so no request for one can be genuine. The one it does make is a
  // clipboard write, when Copy skill is pressed.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, done) => done(perm === 'clipboard-sanitized-write'));

  protocol.handle(MEDIA_SCHEME, async (request) => {
    const asked = new URL(request.url).searchParams.get('p');
    if (!asked) return new Response('No file asked for', { status: 400 });

    let file;
    try {
      file = fs.realpathSync(path.resolve(asked));
    } catch (err) {
      return new Response('Not found', { status: 404 });
    }
    if (!allowed.has(file)) return new Response('Not yours to read', { status: 403 });

    const stat = await fsp.stat(file);
    const type = MEDIA_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

    // Chromium asks for ranges as soon as anyone drags the playhead, and a
    // handler that answers 200 with the whole file every time makes scrubbing
    // a long clip feel broken.
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.get('range') || '').trim());
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else {
        start = Math.max(0, stat.size - Number(range[2]));
      }
      if (start > end || start >= stat.size) {
        return new Response('Range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` },
        });
      }
      status = 206;
    }

    const headers = {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      // Local files only, so there is nowhere for this to be cached to.
      'Cache-Control': 'no-store',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;

    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status, headers });
  });
}


/*
 * Choosing a folder is choosing the clips inside it. Main walks the folder
 * itself with the family's intake and admits exactly the files that walk
 * found, so the page never names a path main did not find, and a folder's own
 * path is never admitted. A file named on its own is admitted as it always
 * was (the probe says whether it is a video). A file found inside a folder
 * whose real place is outside that folder (a link out of it) is not taken,
 * because the person chose the folder, not wherever a link inside it points.
 */
function emptyGather() {
  return { paths: [], folders: 0, name: null, skipped: 0 };
}

async function gatherChosen(chosen) {
  const named = chosen.filter((p) => typeof p === 'string' && p);
  const { files, folders } = await scan(named, {
    extensions: VIDEO_EXTENSIONS.map((e) => '.' + e),
    anyNamed: true,
  });
  const keep = [];
  let skipped = 0;
  for (const f of files) {
    if (f.from) {
      let real;
      let home;
      try { real = fs.realpathSync(f.path); home = fs.realpathSync(f.from); } catch (err) { skipped++; continue; }
      if (real !== home && !real.startsWith(home + path.sep)) { skipped++; continue; }
    }
    keep.push(f);
  }
  const paths = keep.map((f) => f.path);
  allowMedia(paths);
  if (named.length) lastOpenDir = path.dirname(path.resolve(named[0]));
  // Said as "from Holiday" only when one folder was named and nothing else.
  const onlyFolder = folders === 1 && named.length === 1 ? path.basename(path.resolve(named[0])) : null;
  return { paths, folders, name: onlyFolder, skipped };
}

/* --- wiring ------------------------------------------------------------ */

// Kept in plan.js so the command line's --describe states the same list.
const VIDEO_EXTENSIONS = plan.VIDEO_EXTENSIONS;

// The window options live out here so the window test can build its window
// from the same object the app does. A test that writes its own options is
// testing its own options.
const WINDOW_OPTIONS = {
  // The kit's frame, with backgroundColor the page's own, or the default light
  // grey flashes on launch and shows around the content while resizing.
  ...frame(),
  width: 1100,
  height: 800,
  minWidth: 900,
  minHeight: 640,
  webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    // The version, from package.json, for the start screen and the footer.
    // A sandboxed preload cannot read package.json, so it comes on argv.
    additionalArguments: ['--app-version=' + APP_VERSION],
  },
};

// A laptop at 1366x768 has about 728 pixels of height left for a window once
// the taskbar (or the menu bar and Dock) is taken off, and a window opened
// taller than that put the bottom of the screen, the main button included,
// out of reach under the taskbar. So the window, and its minimum, are fitted
// to the work area of the screen it opens on.
function fitToScreen(opts) {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const fit = { ...opts };
  for (const [key, side] of [['width', 'width'], ['height', 'height'], ['minWidth', 'width'], ['minHeight', 'height']]) {
    if (typeof fit[key] === 'number') fit[key] = Math.min(fit[key], area[side]);
  }
  return fit;
}

// A failure is one sentence a person can act on. ffmpeg's own output (lines
// like "[out#0/mp4 @ 0x...] Error opening output") is kept to its last line
// that says what went wrong, after the name of the file that was not made.
// ffmpeg ends every failure with "Conversion failed!", which is no cause, so
// that line is skipped in favour of the one before it.
function plainExportError(err, out) {
  const text = String((err && err.message) || err || '');
  if (!/\[[a-z]+#|@ 0x|Conversion failed|\n/.test(text)) return text;
  const lines = text.split('\n').map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean);
  const causes = lines.filter((l) => !/^conversion failed!?$/i.test(l));
  const last = causes.length ? causes[causes.length - 1].replace(/\.$/, '') : 'ffmpeg stopped';
  return `Just Cut could not finish ${path.basename(String(out))}: ${last.charAt(0).toLowerCase() + last.slice(1)}. Try again, or choose another place to save it.`;
}

/*
 * Exported so test/window.test.cjs can register the same handlers against its
 * own window. Without that the test would be checking a renderer that has
 * nothing to talk to, and would miss a handler going missing here.
 */
function registerHandlers() {
  // Nothing in this app navigates and nothing opens a second window of its
  // own, so both are refused rather than filtered. There is no allowlist to
  // get wrong if there is no allowlist.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e) => e.preventDefault());
  });

  // Picked and dropped come through the same door. A Mac's picker takes files
  // and folders in one window; Windows and Linux cannot offer both, so there
  // pick-videos picks files and pick-folder picks folders.
  ipcMain.handle('pick-videos', async () => {
    const r = await dialog.showOpenDialog(win, {
      defaultPath: lastOpenDir || app.getPath('documents'),
      properties: process.platform === 'darwin'
        ? ['openFile', 'openDirectory', 'multiSelections']
        : ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }],
    });
    if (r.canceled || !r.filePaths.length) return emptyGather();
    return gatherChosen(r.filePaths);
  });

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      defaultPath: lastOpenDir || app.getPath('documents'),
      properties: ['openDirectory', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return emptyGather();
    return gatherChosen(r.filePaths);
  });

  // Dropping is the same act of choosing as picking, so it grants the same
  // permission. The paths can only have come from webUtils in the preload.
  ipcMain.handle('admit-dropped', async (_e, paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string');
    return gatherChosen(list);
  });

  // A picture for a tray tile: only for a file the person chose, and kept, so
  // a tile drawn again does not run ffmpeg again.
  const thumbs = new Map();
  ipcMain.handle('thumbnail', async (_e, file, atSec) => {
    requireAllowed([file]);
    const at = Math.max(0, Math.round((Number(atSec) || 0) * 10) / 10);
    const key = file + '\n' + at;
    if (!thumbs.has(key)) {
      const jpeg = await engine.thumbnail(binary('ffmpeg'), file, at);
      thumbs.set(key, jpeg ? 'data:image/jpeg;base64,' + jpeg.toString('base64') : null);
    }
    return thumbs.get(key);
  });

  ipcMain.handle('probe', async (_e, paths) => {
    const files = Array.isArray(paths) ? paths : [paths];
    requireAllowed(files);
    // Both binaries, not just ffprobe: whether a clip was recorded onto one
    // channel only is a filter graph measurement, and ffprobe cannot run one.
    const bins = { ffprobe: binary('ffprobe'), ffmpeg: binary('ffmpeg') };
    // One file at a time, so a stray .mp3 or a broken file in a drop is
    // refused on its own instead of taking the good clips down with it.
    const clips = [];
    for (const file of files) {
      try {
        const { clips: [m] } = await engine.probe(bins, [file]);
        clips.push({ ...m, path: file, ok: true });
      } catch (err) {
        clips.push({ path: file, ok: false, error: String(err && err.message ? err.message : err) });
      }
    }
    return { clips };
  });

  ipcMain.handle('choose-output', async (_e, defaultName) => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: defaultName || 'edit.mp4',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return r.canceled || !r.filePath ? null : r.filePath;
  });

  ipcMain.handle('export', async (_e, { project, out }) => {
    if (running) return { ok: false, error: 'An export is already running' };
    try {
      const files = (project && project.clips ? project.clips : []).map((c) => c.src);
      if (!files.length) throw new Error('There is nothing on the timeline yet');
      requireAllowed(files);

      // Second of the three places this is checked, and the one the app goes
      // through. A save dialog will happily offer a file that already exists,
      // so the refusal has to live behind it rather than in it.
      if (plan.isDeviceName(out)) {
        throw new Error(`${path.basename(String(out))} is a name Windows keeps for a device, so nothing would be saved. Choose another name.`);
      }
      if (!plan.isSafeOutput(out, files)) {
        throw new Error('That is one of your own clips. Just Cut never writes over the footage it is reading, so pick another name.');
      }
      if (fs.existsSync(out)) {
        throw new Error('There is already a file with that name, and Just Cut never writes over one. Pick another name.');
      }

      // Said in a sentence before ffmpeg is asked, because ffmpeg's own words
      // for these are several lines of its internals.
      const dir = path.dirname(String(out));
      if (!fs.existsSync(dir)) {
        throw new Error(`The folder ${dir} is not there any more, so ${path.basename(String(out))} could not be saved. Choose another place to save it.`);
      }
      try { fs.accessSync(dir, fs.constants.W_OK); } catch {
        throw new Error(`Just Cut is not allowed to save in ${dir}. Choose another place to save it.`);
      }

      const ctl = engine.control();
      running = ctl;
      const measurements = await engine.probe(
        { ffprobe: binary('ffprobe'), ffmpeg: binary('ffmpeg') }, files, { ctl });
      await engine.render(binary('ffmpeg'), project, measurements, { out, ctl }, (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('export-progress', p);
      });
      return { ok: true, path: out };
    } catch (err) {
      if (err && err.cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };
      return { ok: false, error: plainExportError(err, out) };
    } finally {
      running = null;
      if (quitAfterExport) app.quit();
    }
  });

  ipcMain.handle('cancel-export', () => {
    if (running) running.cancel();
  });

  ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(path.resolve(String(file))));

  // Takes no argument on purpose. A handler that accepts a URL and passes it
  // to the operating system hands the page whatever the OS will open, which
  // is a great deal more than a web address. There is one destination and it
  // is written here.
  ipcMain.handle('open-site', () => shell.openExternal('https://ponderdev.com'));
  // The start screen's "How it works", for the skill line: the same rule, one
  // fixed address written here and nothing taken from the page.
  ipcMain.handle('open-how-it-works', () => shell.openExternal('https://ponderdev.com/tools/just-cut/how-it-works'));

  // The skill that ships with the app, as text, for the start screen's Copy
  // skill. One fixed file inside the app; the page names no path.
  ipcMain.handle('skill-text', () => fs.readFileSync(path.join(__dirname, '..', 'agents', 'skills', 'justcut', 'SKILL.md'), 'utf8'));

  // The GPL wants its notices readable by whoever has the app, not just by
  // whoever finds the repo, so they open in a local window of their own. Also
  // a local file, also no network.
  ipcMain.handle('open-licences', () => {
    if (licenceWindow && !licenceWindow.isDestroyed()) return licenceWindow.focus();
    licenceWindow = new BrowserWindow({
      width: 720,
      height: 680,
      title: 'Licences and credits',
      ...frame(),
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    dress(licenceWindow);
    licenceWindow.setMenuBarVisibility(false);
    licenceWindow.loadFile(path.join(__dirname, 'renderer', 'licenses.html'));
  });
}

/* Undo and redo keys. Electron's default menu owns Cmd+Z on the Mac and
   answers it with the text-field undo, which this page has nothing for, so
   the keys are caught here, before the menu, and handed to the page as a
   plain 'undo' or 'redo'. Ctrl on Windows and Linux, where Ctrl+Y is redo too. */
function historyKey(input, platform = process.platform) {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return null;
  const key = String(input.key || '').toLowerCase();
  if (key === 'z') return input.shift ? 'redo' : 'undo';
  if (key === 'y' && platform !== 'darwin' && !input.shift) return 'redo';
  return null;
}

function wireHistoryKeys(contents) {
  contents.on('before-input-event', (e, input) => {
    const which = historyKey(input);
    if (!which) return;
    e.preventDefault();
    contents.send('history', which);
  });
}

function createWindow() {
  win = new BrowserWindow(fitToScreen(WINDOW_OPTIONS));
  dress(win);
  win.setMenuBarVisibility(false);
  wireHistoryKeys(win.webContents);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// A test sets JUST_TEST_NO_WINDOW so requiring this file registers the
// handlers without also opening a window. require.main is not this file when
// Electron 43 runs from source (npm start), so it cannot be the guard.
if (process.env.JUST_TEST_NO_WINDOW !== '1') {
  registerHandlers();
  app.whenReady().then(() => {
    serveMedia();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (!running) return;
    e.preventDefault();
    quitAfterExport = true;
    running.cancel();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

module.exports = {
  registerHandlers, serveMedia, allowMedia, gatherChosen, binary, mediaUrl,
  historyKey, wireHistoryKeys, plainExportError, WINDOW_OPTIONS, MEDIA_SCHEME,
};
