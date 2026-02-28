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

  ipcMain.handle('chat:get-cache', () => {
    const saved = store.get('chatCache', {});
    const sessions = Array.isArray(saved?.sessions) ? saved.sessions : [];
    const messagesBySession = saved?.messagesBySession && typeof saved.messagesBySession === 'object'
      ? saved.messagesBySession
      : {};
    return {
      version: 1,
      sessions,
      messagesBySession,
    };
  });

  ipcMain.handle('chat:save-cache', (event, nextCache) => {
    const cache = nextCache && typeof nextCache === 'object' ? nextCache : {};
    const sessions = Array.isArray(cache.sessions) ? cache.sessions : [];
    const messagesBySession = cache.messagesBySession && typeof cache.messagesBySession === 'object'
      ? cache.messagesBySession
      : {};
    const normalized = {
      version: 1,
      sessions,
      messagesBySession,
    };
    store.set('chatCache', normalized);
    return normalized;
  });

  ipcMain.handle('gateway:get-config', () => {
    const saved = store.get('gatewayConfig', {});
    const legacy = store.get('gateway', {});
    const hasSavedConfig = !!saved && typeof saved === 'object'
      && (
        Object.prototype.hasOwnProperty.call(saved, 'url')
        || Object.prototype.hasOwnProperty.call(saved, 'token')
        || saved.configured === true
      );
    const hasLegacyConfig = !!legacy && typeof legacy === 'object'
      && (
        Object.prototype.hasOwnProperty.call(legacy, 'url')
        || Object.prototype.hasOwnProperty.call(legacy, 'token')
      );

    const savedUrl = typeof saved?.url === 'string' ? saved.url.trim() : '';
    const legacyUrl = typeof legacy?.url === 'string' ? legacy.url.trim() : '';
    const savedToken = typeof saved?.token === 'string' ? saved.token : '';
    const legacyToken = typeof legacy?.token === 'string' ? legacy.token : '';

    const url = savedUrl || legacyUrl || 'ws://localhost:18789';
    const token = savedToken || legacyToken || '';
    const configured = saved?.configured === true || hasSavedConfig || hasLegacyConfig;

    // Compatibility migration: promote legacy gateway config to gatewayConfig.
    if ((!savedUrl || !savedToken || !hasSavedConfig) && (legacyUrl || legacyToken || hasLegacyConfig)) {
      store.set('gatewayConfig', { url, token, configured });
    }

    return { url, token, configured };
  });

  ipcMain.handle('gateway:save-config', (event, config) => {
    const next = config && typeof config === 'object' ? config : {};
    const url = typeof next.url === 'string' && next.url ? next.url : 'ws://localhost:18789';
    const token = typeof next.token === 'string' ? next.token : '';
    const configured = typeof next.configured === 'boolean' ? next.configured : true;
    store.set('gatewayConfig', { url, token, configured });
    store.set('gateway', { url, token });
    return { url, token, configured };
  });

  ipcMain.handle('terminal:save-log', async (event, text) => {
    const result = await dialog.showSaveDialog({
      title: 'Export Terminal Log',
      defaultPath: 'terminal-log.txt',
      filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
    });
    if (result.canceled || !result.filePath) return false;
    const fs = require('fs');
    fs.writeFileSync(result.filePath, text, 'utf8');
    return true;
  });

  ipcMain.on('project:show-context-menu', (event, { projectId }) => {
    if (!projectId) return;
    popupForSender(Menu.buildFromTemplate([
      { label: 'Rename Project', click: () => event.sender.send('project:rename', { projectId }) },
      { type: 'separator' },
      { label: 'Delete Project', click: () => event.sender.send('project:delete', { projectId }) },
    ]), event);
  });

  ipcMain.on('session:show-context-menu', (event, { sessionKey }) => {
    if (!sessionKey) return;
    popupForSender(Menu.buildFromTemplate([
      { label: 'Rename Session', click: () => event.sender.send('session:rename', { sessionKey }) },
      { type: 'separator' },
      { label: 'Delete Session', click: () => event.sender.send('session:delete', { sessionKey }) },
    ]), event);
  });

  ipcMain.on('tab:show-context-menu', (event, payload) => {
    const { projectId, tabId, tabType, tabName } = payload || {};
    if (!projectId || !tabId) return;
    popupForSender(Menu.buildFromTemplate([
      { label: 'Split Terminal', click: () => event.sender.send('tab:split', { projectId, tabId }) },
      { label: 'Kill Process', click: () => event.sender.send('tab:kill', { projectId, tabId }) },
      { label: 'Restart', click: () => event.sender.send('tab:restart', { projectId, tabId, tabType }) },
      { type: 'separator' },
      { label: 'Copy Tab Name', click: () => event.sender.send('tab:copy-name', { projectId, tabId, tabName }) },
      { label: 'Export Log', click: () => event.sender.send('tab:export-log', { projectId, tabId }) },
    ]), event);
  });

  ipcMain.on('notify:process-exit', (event, payload) => {
    const { agentType, projectName, exitCode } = payload || {};
    if (!agentType || !projectName) return;
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return;
    new Notification({ title: 'TGClaw Process Exit', body: `${agentType} · ${projectName} exited with code ${String(exitCode)}` }).show();
  });

  ipcMain.on('notify:chat-message', (event, payload) => {
    const { title, body } = payload || {};
    if (!title || !body) return;
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      const window = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  });

  ipcMain.on('app:set-title', (event, payload) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    const title = payload && typeof payload.title === 'string' ? payload.title : 'TGClaw';
    window.setTitle(title || 'TGClaw');
  });
}

module.exports = { registerIpcHandlers };
