const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tgclaw', {
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  spawnAgent: (opts) => ipcRenderer.invoke('agent:spawn', opts),
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:open-directory'),
  showProjectContextMenu: (projectId) => ipcRenderer.send('project:show-context-menu', { projectId }),
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
});
