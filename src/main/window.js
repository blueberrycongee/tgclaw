const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { store } = require('./store');

const DEFAULT_BOUNDS = { width: 1200, height: 800 };

function getWindowBounds() {
  const saved = store.get('windowBounds', DEFAULT_BOUNDS);
  const bounds = {
    width: Number.isFinite(saved?.width) ? saved.width : DEFAULT_BOUNDS.width,
    height: Number.isFinite(saved?.height) ? saved.height : DEFAULT_BOUNDS.height,
  };
  if (!Number.isFinite(saved?.x) || !Number.isFinite(saved?.y)) return bounds;

  const candidate = { x: saved.x, y: saved.y, width: bounds.width, height: bounds.height };
  const area = screen.getDisplayMatching(candidate).workArea;
  const overlaps = candidate.x < area.x + area.width
    && candidate.x + candidate.width > area.x
    && candidate.y < area.y + area.height
    && candidate.y + candidate.height > area.y;
  if (overlaps) Object.assign(bounds, { x: saved.x, y: saved.y });
  return bounds;
}

function createWindow() {
  const bounds = getWindowBounds();
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });
  win.on('close', () => store.set('windowBounds', win.getBounds()));

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }
  return win;
}

module.exports = { createWindow };
