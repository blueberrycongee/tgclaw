const { BrowserWindow, Menu, Notification, dialog } = require('electron');
const { store } = require('./store');

function popupForSender(menu, event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) menu.popup({ window });
}

function registerIpcHandlers(ipcMain) {
  ipcMain.handle('dialog:open-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Project Directory',
      properties: ['openDirectory'],
      defaultPath: process.env.HOME,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('projects:get', () => {
    const saved = store.get('projects', []);
    return Array.isArray(saved) ? saved : [];
  });

  ipcMain.handle('projects:save', (event, nextProjects) => {
    store.set('projects', Array.isArray(nextProjects) ? nextProjects : []);
  });

  ipcMain.handle('gateway:get-config', () => {
    const saved = store.get('gatewayConfig', {});
    const url = typeof saved?.url === 'string' && saved.url ? saved.url : 'ws://localhost:18789';
    const token = typeof saved?.token === 'string' ? saved.token : '';
    return { url, token };
  });

  ipcMain.handle('gateway:save-config', (event, config) => {
    const next = config && typeof config === 'object' ? config : {};
    const url = typeof next.url === 'string' && next.url ? next.url : 'ws://localhost:18789';
    const token = typeof next.token === 'string' ? next.token : '';
    store.set('gatewayConfig', { url, token });
    return { url, token };
  });

  ipcMain.on('project:show-context-menu', (event, { projectId }) => {
    if (!projectId) return;
    popupForSender(Menu.buildFromTemplate([
      { label: 'Rename Project', click: () => event.sender.send('project:rename', { projectId }) },
      { type: 'separator' },
      { label: 'Delete Project', click: () => event.sender.send('project:delete', { projectId }) },
    ]), event);
  });

  ipcMain.on('tab:show-context-menu', (event, payload) => {
    const { projectId, tabId, tabType, tabName } = payload || {};
    if (!projectId || !tabId) return;
    popupForSender(Menu.buildFromTemplate([
      { label: 'Kill Process', click: () => event.sender.send('tab:kill', { projectId, tabId }) },
      { label: 'Restart', click: () => event.sender.send('tab:restart', { projectId, tabId, tabType }) },
      { type: 'separator' },
      { label: 'Copy Tab Name', click: () => event.sender.send('tab:copy-name', { projectId, tabId, tabName }) },
    ]), event);
  });

  ipcMain.on('notify:process-exit', (event, payload) => {
    const { agentType, projectName, exitCode } = payload || {};
    if (!agentType || !projectName) return;
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return;
    new Notification({ title: 'TGClaw Process Exit', body: `${agentType} · ${projectName} exited with code ${String(exitCode)}` }).show();
  });

  ipcMain.on('app:set-title', (event, payload) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    const title = payload && typeof payload.title === 'string' ? payload.title : 'TGClaw';
    window.setTitle(title || 'TGClaw');
  });
}

module.exports = { registerIpcHandlers };
