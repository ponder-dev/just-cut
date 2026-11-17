'use strict';

/*
 * The only surface the page gets. No node, no filesystem, no network, and no
 * function here takes a URL: openSite goes to one hardcoded address decided
 * in main, and openLicences opens a local window. That is the whole of what
 * this app can reach outside itself.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Kept in step with MEDIA_SCHEME in main.cjs by hand rather than by import,
// because a preload is sandboxed and can only require Electron's own modules.
// It is one short string, and main refuses anything the person using the app
// did not pick, so a mismatch fails loudly instead of quietly widening.
const MEDIA_SCHEME = 'justcut-media';

contextBridge.exposeInMainWorld('justcut', {
  pickVideos: () => ipcRenderer.invoke('pick-videos'),
  probe: (paths) => ipcRenderer.invoke('probe', paths),
  // A small JPEG of one frame, as a data: URL, or null. Main refuses any file
  // the person did not choose.
  thumbnail: (path, atSec) => ipcRenderer.invoke('thumbnail', path, atSec),
  chooseOutput: (defaultName) => ipcRenderer.invoke('choose-output', defaultName),
  exportProject: (project, out) => ipcRenderer.invoke('export', { project, out }),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),

  // Returns its own unsubscribe, so a component that mounts twice does not
  // end up with two listeners quietly doubling every progress update.
  onExportProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('export-progress', handler);
    return () => ipcRenderer.removeListener('export-progress', handler);
  },

  /* Dropped files never went through the picker, so main has not been told it
     may read them. webUtils turns a real File into a path and the same call
     registers it, which is why this is one function and not two: the page can
     only ever hand over a File it was actually given, never a path it made up. */
  admitDropped: async (files) => {
    const paths = [];
    for (const f of files || []) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) paths.push(p);
      } catch (err) {
        // Not a real dropped file. Nothing to admit, nothing to say.
      }
    }
    if (!paths.length) return [];
    return ipcRenderer.invoke('admit-dropped', paths);
  },

  // Undo and redo pressed on the keyboard, caught in main before the default
  // menu can swallow them. Only ever 'undo' or 'redo'.
  onHistory: (cb) => {
    const handler = (_e, which) => { if (which === 'undo' || which === 'redo') cb(which); };
    ipcRenderer.on('history', handler);
    return () => ipcRenderer.removeListener('history', handler);
  },

  revealFile: (path) => ipcRenderer.invoke('reveal', path),
  openSite: () => ipcRenderer.invoke('open-site'),
  openLicences: () => ipcRenderer.invoke('open-licences'),

  // A URL for the timeline to put in a <video>. Synchronous because it is
  // only string building: main decides whether it will actually serve the
  // file, and refuses anything that did not come back from pickVideos.
  fileUrl: (path) => `${MEDIA_SCHEME}://clip/?p=${encodeURIComponent(path)}`,
});
