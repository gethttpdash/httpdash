// Writes build/icon.ico from build/icon-win.svg. Windows draws taskbar and Start icons edge to edge,
// so its icon fills the whole square; build/icon.png keeps the macOS grid's margin (824 of 1024),
// which looks small beside other apps on Windows. The SVG is drawn on a 32-unit grid, so the sizes
// Windows asks for most (16, 32, 48, 64, 256) land on whole pixels. Run `npm run icon:win` after
// changing the SVG.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const build = path.join(__dirname, '..', '..', 'build');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const RENDER = 1024;

// An ICO whose entries are PNGs (Windows Vista and later read them at every size).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(build, 'icon-win.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, width: RENDER, height: RENDER, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent"><img style="display:block;width:${RENDER}px;height:${RENDER}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const big = (await win.webContents.capturePage({ x: 0, y: 0, width: RENDER, height: RENDER })).resize({ width: RENDER, height: RENDER, quality: 'best' });
  const pngs = SIZES.map((size) => ({ size, png: big.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  const out = path.join(build, 'icon.ico');
  fs.writeFileSync(out, ico(pngs));
  console.log(`Wrote build/icon.ico (${SIZES.join(', ')} px, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  app.exit(0);
}).catch((e) => { console.log('The icon could not be written:', (e && e.stack) || e); app.exit(1); });
