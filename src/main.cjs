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
 * The single thing that can leave this machine is a browser being told to
 * open ponderdev.com, from one hardcoded handler that takes no arguments.
 */

const { app, BrowserWindow, screen, ipcMain, dialog, shell, protocol, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');

const engine = require('./engine.cjs');
const plan = require('./plan.js');
const binaries = require('./binaries.cjs');

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
  // location, so no request for one can be genuine.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, done) => done(false));

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

/* --- wiring ------------------------------------------------------------ */

// Kept in plan.js so the command line's --describe states the same list.
const VIDEO_EXTENSIONS = plan.VIDEO_EXTENSIONS;

// The window options live out here so the window test can build its window
// from the same object the app does. A test that writes its own options is
// testing its own options.
const WINDOW_OPTIONS = {
  width: 1100,
  height: 800,
  minWidth: 900,
  minHeight: 640,
  // Matching the page background, or the default light grey flashes on launch
  // and shows around the content while the window is being resized.
  backgroundColor: '#12131a',
  webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
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

  ipcMain.handle('pick-videos', async () => {
    const r = await dialog.showOpenDialog(win, {
      defaultPath: lastOpenDir || app.getPath('documents'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }],
    });
    if (r.canceled || !r.filePaths.length) return [];
    lastOpenDir = path.dirname(r.filePaths[0]);
    // Picking a file is the only thing that grants the page permission to see
    // it. Everything downstream checks against this set.
    return allowMedia(r.filePaths);
  });

  // Dropping a file is the same act of choosing as picking one, so it grants
  // the same permission. The paths can only have come from webUtils in the
  // preload, and allowMedia drops anything that does not resolve on disk.
  ipcMain.handle('admit-dropped', async (_e, paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string');
    allowMedia(list);
    const admitted = list.filter((p) => {
      try { return allowed.has(fs.realpathSync(path.resolve(p))); } catch (err) { return false; }
    });
    if (admitted.length) lastOpenDir = path.dirname(admitted[0]);
    return admitted;
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

      const ctl = engine.control();
      running = ctl;
      const measurements = await engine.probe(
        { ffprobe: binary('ffprobe'), ffmpeg: binary('ffmpeg') }, files);
      await engine.render(binary('ffmpeg'), project, measurements, { out, ctl }, (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('export-progress', p);
      });
      return { ok: true, path: out };
    } catch (err) {
      if (err && err.cancelled) return { ok: false, cancelled: true, error: 'Cancelled' };
      return { ok: false, error: String(err.message || err) };
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

  // The GPL wants its notices readable by whoever has the app, not just by
  // whoever finds the repo, so they open in a local window of their own. Also
  // a local file, also no network.
  ipcMain.handle('open-licences', () => {
    if (licenceWindow && !licenceWindow.isDestroyed()) return licenceWindow.focus();
    licenceWindow = new BrowserWindow({
      width: 720,
      height: 680,
      title: 'Licences and credits',
      backgroundColor: '#12131a',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
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
  win = new BrowserWindow({
    ...fitToScreen(WINDOW_OPTIONS),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
  });
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
  registerHandlers, serveMedia, allowMedia, binary, mediaUrl,
  historyKey, wireHistoryKeys, WINDOW_OPTIONS, MEDIA_SCHEME,
};
