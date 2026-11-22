'use strict';

/*
 * Finding ffmpeg and ffprobe.
 *
 * The desktop app carries its own copies, because someone downloading a free
 * app should not then have to install a video encoder. The command line does
 * not: anyone using a terminal either has ffmpeg or can install it with one
 * command, and a 300MB npm package to avoid that would be rude.
 *
 * So: the bundled copy if there is one, otherwise whatever is on PATH. One
 * resolver, a flag for which of the two behaviours the caller wants.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';

function fromDir(dir, name) {
  if (!dir) return null;
  // Platform first: linux and mac both call themselves x64, so an arch alone
  // is not enough to tell a linux binary from a mac one sitting side by side.
  for (const candidate of [
    `${name}-${process.platform}-${process.arch}${EXE}`,
    `${name}-${process.arch}${EXE}`,
    `${name}${EXE}`,
  ]) {
    const full = path.join(dir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function fromPath(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(finder, [name + EXE], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n')[0].trim();
    return found || null;
  } catch (err) {
    return null;
  }
}

/**
 * @param name    'ffmpeg' or 'ffprobe'
 * @param dirs    vendor directories to try first, in order
 * @param allowPath  false for the packaged app, which must not depend on the
 *                   machine having its own ffmpeg
 */
function resolve(name, dirs = [], allowPath = true) {
  for (const dir of dirs) {
    const hit = fromDir(dir, name);
    if (hit) return hit;
  }
  if (allowPath) {
    const hit = fromPath(name);
    if (hit) return hit;
  }
  if (!allowPath) {
    // Only the desktop app asks for the bundled copy alone. Packaged, a
    // person sees this, and has no npm to run: the copy they have is broken
    // and a fresh download is the fix. From a checkout it is a developer who
    // has not fetched the binaries yet.
    throw new Error(__dirname.includes('app.asar')
      ? `This copy of Just Cut is missing its ${name}. Download Just Cut again from ponderdev.com.`
      : `${name} not found in vendor/ffmpeg. From a checkout, fetch it with: npm run fetch-ffmpeg`);
  }
  throw new Error(
    `${name} not found (bundled or on PATH).\n` +
    `Install it with your package manager, for example:\n` +
    `  arch    sudo pacman -S ffmpeg\n` +
    `  debian  sudo apt install ffmpeg\n` +
    `  mac     brew install ffmpeg`,
  );
}

module.exports = { resolve, fromDir, fromPath };
