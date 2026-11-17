// Generates src/renderer/licenses.html from the files the app actually ships.
//
//   node scripts/make-licenses.mjs
//
// Built from THIRD-PARTY-NOTICES.md and licenses/*.txt rather than from a copy
// of them, so the credits screen inside the app is always the text on disk. A
// credits screen that has drifted from what is bundled is worse than none, so
// this is never edited by hand and the dist scripts run it first.
//
// Anything dropped into licenses/ appears without this file being touched.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Only so the headings read like licences rather than like filenames. A file
// with no entry here falls back to its own name, so adding one is optional.
const TITLES = {
  'gpl-3.0': 'GNU General Public License v3.0',
  'gpl-2.0': 'GNU General Public License v2.0',
  'lgpl-2.1': 'GNU Lesser General Public License v2.1',
  'ffmpeg-license': 'FFmpeg: LICENSE.md',
  'electron-mit': 'Electron: MIT',
};

const notices = await fs.readFile(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
const dir = path.join(root, 'licenses');
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.txt')).sort();

const sections = [];
for (const file of files) {
  const text = await fs.readFile(path.join(dir, file), 'utf8');
  const name = file.replace(/\.txt$/, '');
  sections.push(
    `<details><summary>${esc(TITLES[name] || name)}</summary><pre>${esc(text)}</pre></details>`,
  );
}

// A file of its own rather than a <style> block, so the page can say
// style-src 'self' and mean it. An inline block needs 'unsafe-inline', which
// is the one relaxation that makes a policy stop being worth having, and the
// credits screen was the last page still asking for it.
const css = `body { margin:0; padding:28px 34px; background:#12131a; color:#eceef5;
       font:13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
h1 { font-size:18px; margin:0 0 4px; }
h2 { font-size:14px; margin:26px 0 6px; }
pre.notices { white-space:pre-wrap; font:inherit; color:#c3c8d8; }
details { border:1px solid #2c2f3d; border-radius:9px; margin:8px 0; background:#191b24; }
summary { padding:9px 14px; cursor:pointer; font-weight:600; }
details pre { margin:0; padding:0 14px 14px; max-height:340px; overflow:auto;
              white-space:pre-wrap; font:11px/1.5 ui-monospace, Menlo, monospace; color:#9aa0b4; }
`;

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self';">
<title>Licences and credits</title>
<link rel="stylesheet" href="licenses.css">
</head>
<body>
<h1>Licences and credits</h1>
<pre class="notices">${esc(notices)}</pre>
<h2>Full licence texts</h2>
${sections.join('\n')}
</body></html>
`;

const out = path.join(root, 'src', 'renderer', 'licenses.html');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, html);
await fs.writeFile(path.join(path.dirname(out), 'licenses.css'), css);
console.log(`src/renderer/licenses.html and licenses.css written, ${files.length} licence texts`);
