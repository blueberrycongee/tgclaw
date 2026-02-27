const { app, BrowserWindow, ipcMain } = require('electron');
const { registerIpcHandlers } = require('./ipc-handlers');
const { setupApplicationMenu } = require('./menu');
const { registerPtyHandlers, killAllTerminals } = require('./pty-manager');
const { createWindow } = require('./window');

registerPtyHandlers(ipcMain);
registerIpcHandlers(ipcMain);

app.whenReady().then(() => {
  setupApplicationMenu();
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  killAllTerminals();
  if (process.platform !== 'darwin') app.quit();
});
