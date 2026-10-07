// A separate process models a game: its focus is independent of the companion's Chromium windows.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const directory = process.argv.at(-1);
fs.mkdirSync(directory, { recursive: true });
app.setName('Companion foreground check');
app.setPath('userData', directory);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 400, title: 'Companion foreground check', backgroundColor: '#345e48', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><body style="background:#345e48;color:#fff;padding:40px;font:24px sans-serif">Game foreground check</body>'));
  const handle = win.getNativeWindowHandle();
  fs.writeFileSync(path.join(directory, 'ready.txt'), (handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE()).toString());
});
app.on('window-all-closed', () => app.quit());
