const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { registerIpcHandlers } = require('./ipc-handlers');
const { setupApplicationMenu } = require('./menu');
const { registerPtyHandlers, killAllTerminals } = require('./pty-manager');
const { createWindow } = require('./window');

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

/**
 * Ensure spawn-helper has executable permissions.
 * This fixes issues where permissions may be lost during packaging or installation.
 */
function ensureSpawnHelperPermissions() {
  try {
    const nodePtyPath = require.resolve('node-pty');
    const nodePtyRoot = path.join(nodePtyPath, '../..');
    const prebuildsDir = path.join(nodePtyRoot, 'prebuilds');

    if (!fs.existsSync(prebuildsDir)) {
      console.warn('node-pty prebuilds directory not found');
      return;
    }

    // Check all platform-specific spawn-helper binaries
    const platforms = fs.readdirSync(prebuildsDir);
    platforms.forEach((platform) => {
      const spawnHelperPath = path.join(prebuildsDir, platform, 'spawn-helper');
      if (fs.existsSync(spawnHelperPath)) {
        const stats = fs.statSync(spawnHelperPath);
        // Check if executable bit is set (mode & 0o111)
        if ((stats.mode & 0o111) === 0) {
          console.log(`Fixing permissions for ${spawnHelperPath}`);
          fs.chmodSync(spawnHelperPath, 0o755);
        }
      }
    });
  } catch (error) {
    console.error('Failed to ensure spawn-helper permissions:', error);
  }
}

registerPtyHandlers(ipcMain);
registerIpcHandlers(ipcMain);

app.whenReady().then(() => {
  ensureSpawnHelperPermissions();
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
