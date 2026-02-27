const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tgclaw', {
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  spawnAgent: (opts) => ipcRenderer.invoke('agent:spawn', opts),
  getProjects: () => ipcRenderer.invoke('projects:get'),
  saveProjects: (projects) => ipcRenderer.invoke('projects:save', projects),
  getGatewayConfig: () => ipcRenderer.invoke('gateway:get-config'),
  saveGatewayConfig: (config) => ipcRenderer.invoke('gateway:save-config', config),
  saveTerminalLog: (text) => ipcRenderer.invoke('terminal:save-log', text),
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:open-directory'),
  showProjectContextMenu: (projectId) => ipcRenderer.send('project:show-context-menu', { projectId }),
  showTabContextMenu: (payload) => ipcRenderer.send('tab:show-context-menu', payload),
  setWindowTitle: (title) => ipcRenderer.send('app:set-title', { title }),
  notifyProcessExit: ({ agentType, projectName, exitCode }) => ipcRenderer.send('notify:process-exit', {
    agentType,
    projectName,
    exitCode,
  }),
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),
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
  onProjectDelete: (callback) => {
    const channel = 'project:delete';
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onProjectRename: (callback) => {
    const channel = 'project:rename';
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onAppShortcut: (callback) => {
    const channel = 'app:shortcut';
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onTabKill: (callback) => {
    const channel = 'tab:kill';
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onTabRestart: (callback) => {
    const channel = 'tab:restart';
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onTabCopyName: (callback) => {
    const channel = 'tab:copy-name';
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
