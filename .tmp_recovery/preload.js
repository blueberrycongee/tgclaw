const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tgclaw', {
  // 创建原始终端
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),

  // 启动 agent CLI
  spawnAgent: (opts) => ipcRenderer.invoke('agent:spawn', opts),

  // 写入终端
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),

  // 调整大小
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),

  // 关闭终端
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),

  // 监听终端输出
  onPtyData: (id, callback) => {
    const channel = `pty:data:${id}`;
    const listener = (event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // 监听终端退出
  onPtyExit: (id, callback) => {
    const channel = `pty:exit:${id}`;
    const listener = (event, code) => callback(code);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
