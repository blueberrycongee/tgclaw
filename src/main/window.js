const path = require('path');
const { BrowserWindow } = require('electron');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../../preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../../index.html'));
  return win;
}

module.exports = { createWindow };
