const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const pty = require('node-pty');

const terminals = {};
let nextTermId = 1;

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
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('pty:create', (event, { cols, rows, cwd, cmd }) => {
  const id = nextTermId++;
  const shell = cmd || process.env.SHELL || '/bin/zsh';

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  terminals[id] = ptyProcess;

  ptyProcess.onData((data) => {
    event.sender.send(`pty:data:${id}`, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    event.sender.send(`pty:exit:${id}`, exitCode);
    delete terminals[id];
  });

  return id;
});

ipcMain.handle('agent:spawn', (event, { type, cwd, cols, rows }) => {
  const id = nextTermId++;
  const cmds = {
    'claude-code': { cmd: 'claude', args: [] },
    'codex': { cmd: 'codex', args: [] },
    'goose': { cmd: 'goose', args: [] },
    'aider': { cmd: 'aider', args: [] },
  };

  const agent = cmds[type] || { cmd: type, args: [] };

  const ptyProcess = pty.spawn(agent.cmd, agent.args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  terminals[id] = ptyProcess;

  ptyProcess.onData((data) => {
    event.sender.send(`pty:data:${id}`, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    event.sender.send(`pty:exit:${id}`, exitCode);
    delete terminals[id];
  });

  return id;
});

ipcMain.handle('dialog:open-directory', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Project Directory',
    properties: ['openDirectory'],
    defaultPath: process.env.HOME,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.on('pty:write', (event, { id, data }) => {
  if (terminals[id]) terminals[id].write(data);
});

ipcMain.on('pty:resize', (event, { id, cols, rows }) => {
  if (terminals[id]) terminals[id].resize(cols, rows);
});

ipcMain.on('pty:kill', (event, { id }) => {
  if (terminals[id]) {
    terminals[id].kill();
    delete terminals[id];
  }
});

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  Object.values(terminals).forEach((p) => p.kill());
  if (process.platform !== 'darwin') app.quit();
});
