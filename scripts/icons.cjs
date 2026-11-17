// Renders build/icon.svg to build/icon.png at 1024x1024, and to the iconset
// sizes macOS actually shows.
//
// ImageMagick's built-in SVG renderer drops gradients, and the house tile is
// nothing but a gradient, so we let Chromium do it instead. Every size is
// rendered from the vector rather than downscaled from the 1024, because the
// small entries are where the icon lives or dies: 16 and 32 get a shape drawn
// at that size with the hinting Chromium gives it, not a blur of the big one.
//
//   electron scripts/icons.cjs

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = 1024;
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8');

// name:pixels. macOS wants both the 1x and 2x of each logical size, and the
// same pixel size is asked for twice under two names on purpose.
const ICONSET = [
  ['icon_16x16', 16],
  ['icon_16x16@2x', 32],
  ['icon_32x32', 32],
  ['icon_32x32@2x', 64],
  ['icon_128x128', 128],
  ['icon_128x128@2x', 256],
  ['icon_256x256', 256],
  ['icon_256x256@2x', 512],
  ['icon_512x512', 512],
  ['icon_512x512@2x', 1024],
];

app.disableHardwareAcceleration();

function page(size) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
  svg{display:block;width:${size}px;height:${size}px}
</style></head><body>${svg}</body></html>`;
}

async function render(win, size) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(size)));
  // Give the renderer a frame to paint the gradients before we grab it.
  await new Promise((r) => setTimeout(r, 250));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.toPNG();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: MAIN,
    height: MAIN,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true },
  });

  const png = await render(win, MAIN);
  fs.writeFileSync(path.join(root, 'build/icon.png'), png);
  console.log(`build/icon.png written, ${(png.length / 1024).toFixed(0)}KB, ${MAIN}x${MAIN}`);

  const set = path.join(root, 'build/icon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set, { recursive: true });

  // Cache by pixel size, so 32 and 256 are not rendered twice for their two
  // names, and the two files are byte identical when they should be.
  const byPixels = new Map();
  for (const [name, size] of ICONSET) {
    if (!byPixels.has(size)) byPixels.set(size, await render(win, size));
    fs.writeFileSync(path.join(set, `${name}.png`), byPixels.get(size));
  }
  console.log(`build/icon.iconset written, ${ICONSET.length} entries`);

  app.exit(0);
});
