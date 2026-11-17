/*
 * Puts ffmpeg and ffprobe into vendor/ffmpeg, and refuses to leave anything
 * there that Just Cut would not be allowed to ship.
 *
 *   node scripts/fetch-ffmpeg.mjs             this machine's platform and arch
 *   node scripts/fetch-ffmpeg.mjs --all       every build a release needs
 *   node scripts/fetch-ffmpeg.mjs --verify    check what is already there, fetch nothing
 *
 * The binaries are 40 to 150MB each, they are not ours to redistribute through
 * our own git history, and they change on someone else's schedule. So vendor/
 * is ignored and this fetches on demand.
 *
 * If a host moves, drop the binaries into vendor/ffmpeg by hand under these
 * names and run --verify. Nothing else in the app cares where they came from:
 *
 *   ffmpeg-darwin-x64    ffmpeg-darwin-arm64    ffmpeg-linux-x64    ffmpeg-win32-x64.exe
 *   ffprobe-darwin-x64   ffprobe-darwin-arm64   ffprobe-linux-x64   ffprobe-win32-x64.exe
 *
 * The names carry the platform as well as the arch because Linux and macOS
 * both call themselves x64, so ffmpeg-x64 is ambiguous the moment both are
 * present, and a Linux box will happily pick up a Mach-O file and fail to run
 * it. src/binaries.cjs resolves exactly these names.
 *
 * This script is also part of the licence notice. THIRD-PARTY-NOTICES.md says
 * which published builds are bundled; this is the record of where they came
 * from and what was checked before they were accepted.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, '..', 'vendor', 'ffmpeg');

// evermeet publishes GPL mac builds and a JSON endpoint giving the current
// URL, so we ask rather than hardcode a version that will rot.
const MAC_INFO = (tool) => `https://evermeet.cx/ffmpeg/info/${tool}/release`;

// evermeet is x86_64 only. osxexperts publishes the Apple Silicon builds, with
// a SHA-256 for each, so those are checked before anything is installed.
//
// The published hash is of the binary inside the zip, not of the zip, and this
// checks the same thing for a reason: a zip is not byte stable. It carries
// timestamps, filesystem attributes and a compressor version, so the same
// binary rezipped gives a different hash and a hash of the archive would go
// stale without the thing we actually care about changing. The binary is the
// artefact being trusted, so the binary is what gets hashed.
const MAC_ARM = {
  ffmpeg: {
    url: 'https://www.osxexperts.net/ffmpeg9arm.zip',
    sha256: '591260c945d0eef150e3bf82b0ef988bd36a9cecc18ff05d6679617159f0a95e',
  },
  ffprobe: {
    url: 'https://www.osxexperts.net/ffprobe9arm.zip',
    sha256: 'e11c17e8200b3ee4c4c186d245e2b4053f01d56957336c1817fca0b997469106',
  },
};

// BtbN publishes GPL win64 builds with a stable "latest" tag.
// Every download fails loudly and retries: these hosts are not ours, and a
// bad response saved as the archive once broke the build at unpacking.
const WIN_ZIP =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

// johnvansickle publishes the static Linux builds everyone uses. GPL, with
// libx264, and the tarball nests everything under a versioned directory.
const LINUX = {
  x64: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
  arm64: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz',
};

const verifyOnly = process.argv.includes('--verify');
const wanted = process.argv.includes('--all')
  ? [['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']]
  : [[process.platform, process.arch]];

fs.mkdirSync(vendor, { recursive: true });

function sh(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
}

// Windows has no unzip, but since Windows 10 it ships bsdtar as tar.exe, and
// bsdtar reads zip as readily as tar. Mac and Linux keep unzip, because GNU
// tar on Linux does not read zip at all.
function unzip(zip, dest) {
  if (process.platform === 'win32') sh('tar', ['-xf', zip, '-C', dest]);
  else sh('unzip', ['-oq', zip, '-d', dest]);
}

/* ------------------------------------------------------------------ *
 * The licence check.
 *
 * Nothing is allowed to sit in vendor/ without saying how it was built.
 * ffmpeg embeds its configure line in the binary, so any build can be asked,
 * and three answers matter:
 *
 *   --enable-nonfree   Fatal. It marks a build that has been combined with
 *                      code whose terms the GPL cannot be combined with, and
 *                      such a build says so itself: "nonfree and
 *                      unredistributable". Nobody may redistribute it, us
 *                      included, whatever the app around it is licensed as.
 *   --enable-gpl       Required. Without it there is no libx264 in the build,
 *                      and the licence story in THIRD-PARTY-NOTICES.md is not
 *                      the one being told.
 *   --enable-libx264   Required in ffmpeg. It is the only H.264 encoder these
 *                      builds carry, and the app cannot export without it.
 *                      ffprobe never encodes, so a missing libx264 there is
 *                      only worth a warning.
 *
 * This is not hypothetical. The private app Just Cut was carved out of
 * shipped an arm64 ffmpeg built --enable-nonfree for its entire life, because
 * nothing ever looked. So this looks, every time, rather than a note in a file
 * asking somebody to remember.
 *
 * --enable-version3 is reported but never enforced: it decides whether the
 * build is GPL v2 or later or GPL v3 or later, which the notices have to state
 * correctly, and both are fine to ship.
 * ------------------------------------------------------------------ */

const NONFREE_MARK = 'nonfree and unredistributable';

// A build for another platform cannot be executed here, and refusing to check
// it would mean the cross builds in a release were the only ones nobody ever
// looked at. The configure line is a plain string inside the executable, so it
// can be read out of any of them without running anything.
function configFromBytes(buf) {
  let at = buf.indexOf('--enable-gpl');
  if (at === -1) at = buf.indexOf('--prefix=');
  if (at === -1) return '';
  let start = at;
  let end = at;
  const printable = (b) => b >= 0x20 && b < 0x7f;
  while (start > 0 && printable(buf[start - 1])) start--;
  while (end < buf.length && printable(buf[end])) end++;
  // The run may start with the format string ffmpeg prints the line through,
  // so begin at the first flag rather than at whatever came before it.
  const text = buf.toString('latin1', start, end);
  const flag = text.indexOf('--');
  return (flag === -1 ? text : text.slice(flag)).trim();
}

function configFromRun(file) {
  const out = execFileSync(file, ['-version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  }).toString();
  const line = out.split('\n').find((l) => l.startsWith('configuration:'));
  return line ? line.slice('configuration:'.length).trim() : '';
}

// Same platform is worth attempting whatever the arch says, because the arch a
// binary can run is a property of the machine, not of this process: a mac runs
// both, one of them through Rosetta, and node itself may be the translated one.
// If the spawn fails, the byte scan below picks the check up.
function worthRunning(platform) {
  return platform === process.platform;
}

function inspect(file, platform) {
  // The self-report is read from the bytes either way, because a nonfree build
  // announces itself in a string that -version does not print.
  const buf = fs.readFileSync(file);
  const marked = buf.indexOf(NONFREE_MARK) !== -1;

  if (worthRunning(platform)) {
    try {
      return { how: 'ran it', config: configFromRun(file), marked };
    } catch {
      // Wrong arch, no Rosetta, quarantined download, missing library. Fall
      // through rather than let an execution problem look like a clean pass.
    }
  }
  return { how: 'read the configure line out of the binary', config: configFromBytes(buf), marked };
}

const checked = [];

function check(file, tool, platform, arch, fresh) {
  const name = path.basename(file);
  const { how, config, marked } = inspect(file, platform);

  // A binary this run downloaded is deleted on refusal, because leaving it
  // there means the next run finds it and skips the fetch. One that was
  // already there is somebody's own file: say what is wrong with it loudly and
  // let them remove it.
  const refuse = (why) => {
    if (fresh) fs.rmSync(file, { force: true });
    throw new Error(
      `${name} refused.\n  ${why}\n  configuration: ${config || '(none found)'}\n` +
      (fresh
        ? '  It has been deleted rather than left where a build would pick it up.'
        : `  Delete ${file} and fetch a build that passes.`),
    );
  };

  if (marked || /--enable-nonfree\b/.test(config)) {
    refuse(
      'This build is nonfree. It reports itself as "nonfree and unredistributable",\n' +
      '  which means nobody may redistribute it, so it cannot ship inside Just Cut.',
    );
  }
  if (!config) {
    refuse('No ffmpeg configure line in this file. It may not be an ffmpeg build at all.');
  }
  if (!/--enable-gpl\b/.test(config)) {
    refuse('Not built with --enable-gpl, so it carries no libx264 and is not the build the notices describe.');
  }
  const x264 = /--enable-libx264\b/.test(config);
  if (tool === 'ffmpeg' && !x264) {
    refuse('No libx264 in this build. Just Cut cannot export without it.');
  }

  const licence = /--enable-version3\b/.test(config) ? 'GPL v3 or later' : 'GPL v2 or later';
  checked.push({ name, licence, how, x264 });
  console.log(`  ${name}: ${licence}${x264 ? ', libx264' : ''}, not nonfree (${how})`);
  if (tool === 'ffprobe' && !x264) {
    console.log('    note: no libx264 in this ffprobe. It never encodes, so this is only odd, not fatal.');
  }
}

/* ------------------------------------------------------------------ *
 * Fetching.
 * ------------------------------------------------------------------ */

async function macTool(tool, arch) {
  const target = path.join(vendor, `${tool}-darwin-${arch}`);
  if (fs.existsSync(target)) {
    console.log(`  have ${tool}-darwin-${arch}`);
    return check(target, tool, 'darwin', arch, false);
  }

  if (arch === 'arm64') {
    const { url, sha256 } = MAC_ARM[tool];
    const tmp = path.join(os.tmpdir(), `${tool}-arm-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    console.log(`  fetching ${tool} for mac arm64`);
    sh('curl', ['-sL', '--fail', '--retry', '3', '--retry-delay', '5', '--retry-all-errors', '--max-time', '900', '-o', path.join(tmp, 'a.zip'), url]);
    unzip(path.join(tmp, 'a.zip'), tmp);

    const got = createHash('sha256').update(fs.readFileSync(path.join(tmp, tool))).digest('hex');
    if (got !== sha256) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(
        `${tool}-darwin-arm64 checksum mismatch.\n  expected ${sha256}\n  got      ${got}\n` +
        'Refusing to install it. Either the publisher rebuilt it, in which case update\n' +
        'the hash above after checking the site, or something is wrong.',
      );
    }

    fs.copyFileSync(path.join(tmp, tool), target);
    fs.chmodSync(target, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`  ${tool}-darwin-arm64 checksum ok`);
    return check(target, tool, 'darwin', arch, true);
  }

  const info = JSON.parse(sh('curl', ['-sL', '--fail', '--retry', '3', '--retry-delay', '5', '--retry-all-errors', '--max-time', '60', MAC_INFO(tool)]));
  const url = info.download.zip.url;
  const tmp = path.join(os.tmpdir(), `${tool}-${Date.now()}.zip`);
  console.log(`  fetching ${tool} ${info.version} for mac ${arch}`);
  sh('curl', ['-sL', '--fail', '--retry', '3', '--retry-delay', '5', '--retry-all-errors', '--max-time', '600', '-o', tmp, url]);
  unzip(tmp, vendor);
  fs.renameSync(path.join(vendor, tool), target);
  fs.chmodSync(target, 0o755);
  fs.unlinkSync(tmp);
  return check(target, tool, 'darwin', arch, true);
}

async function windows() {
  const tools = ['ffmpeg', 'ffprobe'];
  const need = tools.filter((t) => !fs.existsSync(path.join(vendor, `${t}-win32-x64.exe`)));

  if (need.length) {
    const tmp = path.join(os.tmpdir(), `ffmpeg-win-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    console.log('  fetching ffmpeg and ffprobe for windows x64 (~150MB each)');
    sh('curl', ['-sL', '--fail', '--retry', '3', '--retry-delay', '5', '--retry-all-errors', '--max-time', '900', '-o', path.join(tmp, 'w.zip'), WIN_ZIP]);
    unzip(path.join(tmp, 'w.zip'), tmp);

    for (const tool of need) {
      // The zip nests everything under a versioned folder, so go and find it.
      const found = findFile(tmp, `${tool}.exe`);
      if (!found) throw new Error(`${tool}.exe was not in the windows archive`);
      fs.copyFileSync(found, path.join(vendor, `${tool}-win32-x64.exe`));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log('  have both windows binaries');
  }

  for (const tool of tools) {
    check(path.join(vendor, `${tool}-win32-x64.exe`), tool, 'win32', 'x64', need.includes(tool));
  }
}

async function linux(arch) {
  const url = LINUX[arch];
  if (!url) return console.log(`  no linux build published for ${arch}`);
  const tools = ['ffmpeg', 'ffprobe'];
  const need = tools.filter((t) => !fs.existsSync(path.join(vendor, `${t}-linux-${arch}`)));

  if (need.length) {
    const tmp = path.join(os.tmpdir(), `ffmpeg-linux-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    console.log(`  fetching ffmpeg and ffprobe for linux ${arch} (~80MB each)`);
    sh('curl', ['-sL', '--fail', '--retry', '3', '--retry-delay', '5', '--retry-all-errors', '--max-time', '900', '-o', path.join(tmp, 'f.tar.xz'), url]);
    sh('tar', ['xf', path.join(tmp, 'f.tar.xz'), '-C', tmp]);

    for (const tool of need) {
      const found = findFile(tmp, tool);
      if (!found) throw new Error(`${tool} was not in the linux archive`);
      const target = path.join(vendor, `${tool}-linux-${arch}`);
      fs.copyFileSync(found, target);
      fs.chmodSync(target, 0o755);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log(`  have both linux ${arch} binaries`);
  }

  for (const tool of tools) {
    check(path.join(vendor, `${tool}-linux-${arch}`), tool, 'linux', arch, need.includes(tool));
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Go.
 * ------------------------------------------------------------------ */

async function main() {
  if (verifyOnly) {
    const present = fs.readdirSync(vendor).filter((f) => /^(ffmpeg|ffprobe)-/.test(f));
    if (!present.length) {
      console.log('vendor/ffmpeg is empty. Run this without --verify to fetch.');
    }
    for (const name of present.sort()) {
      const [, tool, platform, arch] = /^(ffmpeg|ffprobe)-([a-z0-9]+)-([a-z0-9]+)(?:\.exe)?$/.exec(name) || [];
      if (!tool) {
        console.log(`  skipping ${name}, not a name this app looks for`);
        continue;
      }
      check(path.join(vendor, name), tool, platform, arch, false);
    }
  } else {
    for (const [platform, arch] of wanted) {
      console.log(`${platform} ${arch}`);
      if (platform === 'darwin') {
        await macTool('ffmpeg', arch);
        await macTool('ffprobe', arch);
      } else if (platform === 'win32') {
        await windows();
      } else if (platform === 'linux') {
        await linux(arch);
      } else {
        console.log('  no automatic source for this platform, install ffmpeg yourself');
      }
    }
  }

  console.log('\nvendor/ffmpeg now holds:');
  for (const f of fs.readdirSync(vendor).sort()) {
    const size = (fs.statSync(path.join(vendor, f)).size / 1e6).toFixed(0) + 'MB';
    const seen = checked.find((c) => c.name === f);
    console.log(' ', f.padEnd(24), size.padStart(6), seen ? ` ${seen.licence}` : '  not checked this run');
  }
}

try {
  await main();
} catch (err) {
  // These failures are the point of the script, so they get read rather than
  // grepped out of a stack trace.
  console.error(`\n${err.message}\n`);
  process.exit(1);
}
