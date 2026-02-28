const { contextBridge, ipcRenderer } = require('electron');

function onIpc(channel) {
  return (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('tgclaw', {
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  spawnAgent: (opts) => ipcRenderer.invoke('agent:spawn', opts),
  spawnCommand: (opts) => ipcRenderer.invoke('pty:spawn-command', opts),
  startTerminalSession: (opts) => ipcRenderer.invoke('terminal:start', opts),
  attachTerminalSession: (opts) => ipcRenderer.invoke('terminal:attach', opts),
  getTerminalSessionStatus: (opts) => ipcRenderer.invoke('terminal:status', opts),
  getProjects: () => ipcRenderer.invoke('projects:get'),
  saveProjects: (projects) => ipcRenderer.invoke('projects:save', projects),
  getChatCache: () => ipcRenderer.invoke('chat:get-cache'),
  saveChatCache: (cache) => ipcRenderer.invoke('chat:save-cache', cache),
  getGatewayConfig: () => ipcRenderer.invoke('gateway:get-config'),
  saveGatewayConfig: (config) => ipcRenderer.invoke('gateway:save-config', config),
  saveTerminalLog: (text) => ipcRenderer.invoke('terminal:save-log', text),
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:open-directory'),
  showProjectContextMenu: (projectId) => ipcRenderer.send('project:show-context-menu', { projectId }),
  showSessionContextMenu: (sessionKey) => ipcRenderer.send('session:show-context-menu', { sessionKey }),
  showTabContextMenu: (payload) => ipcRenderer.send('tab:show-context-menu', payload),
  setWindowTitle: (title) => ipcRenderer.send('app:set-title', { title }),
  notifyProcessExit: ({ agentType, projectName, exitCode }) => ipcRenderer.send('notify:process-exit', {
    agentType,
    projectName,
    exitCode,
  }),
  notifyChatMessage: ({ title, body }) => ipcRenderer.send('notify:chat-message', { title, body }),
  writeTerminalSession: (terminalSessionId, data) => ipcRenderer.send('terminal:input', { terminalSessionId, data }),
  resizeTerminalSession: (terminalSessionId, cols, rows) => ipcRenderer.send('terminal:resize', {
    terminalSessionId,
    cols,
    rows,
  }),
  killTerminalSession: (terminalSessionId) => ipcRenderer.send('terminal:kill', { terminalSessionId }),
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),
  onTerminalSessionData: (terminalSessionId, callback) => {
    const channel = `terminal:data:${terminalSessionId}`;
    const listener = (event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onTerminalSessionExit: (terminalSessionId, callback) => {
    const channel = `terminal:exit:${terminalSessionId}`;
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPtyData: (id, callback) => {
    const channel = `pty:data:${id}`;
    const listener = (event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPtyExit: (id, callback) => {
    const channel = `pty:exit:${id}`;
    const listener = (event, code) => callback(code);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onProjectDelete: onIpc('project:delete'),
  onProjectRename: onIpc('project:rename'),
  onSessionDelete: onIpc('session:delete'),
  onSessionRename: onIpc('session:rename'),
  onAppShortcut: onIpc('app:shortcut'),
  onTabKill: onIpc('tab:kill'),
  onTabExportLog: onIpc('tab:export-log'),
  onTabSplit: onIpc('tab:split'),
  onTabRestart: onIpc('tab:restart'),
  onTabCopyName: onIpc('tab:copy-name'),
});
