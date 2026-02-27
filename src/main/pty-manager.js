const pty = require('node-pty');

const terminals = {};
let nextTermId = 1;

const agentCommands = {
  'claude-code': { cmd: 'claude', args: [] },
  codex: { cmd: 'codex', args: [] },
  goose: { cmd: 'goose', args: [] },
  aider: { cmd: 'aider', args: [] },
};

function spawnProcess({ cmd, args = [], cols, rows, cwd }) {
  return pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

function bindTerminal(event, id, processRef) {
  terminals[id] = processRef;
  processRef.onData((data) => event.sender.send(`pty:data:${id}`, data));
  processRef.onExit(({ exitCode }) => {
    event.sender.send(`pty:exit:${id}`, exitCode);
    delete terminals[id];
  });
}

function registerPtyHandlers(ipcMain) {
  ipcMain.handle('pty:create', (event, { cols, rows, cwd, cmd }) => {
    const id = nextTermId++;
    const processRef = spawnProcess({ cmd: cmd || process.env.SHELL || '/bin/zsh', cols, rows, cwd });
    bindTerminal(event, id, processRef);
    return id;
  });

  ipcMain.handle('agent:spawn', (event, { type, cwd, cols, rows }) => {
    const id = nextTermId++;
    const agent = agentCommands[type] || { cmd: type, args: [] };

    try {
      bindTerminal(event, id, spawnProcess({ cmd: agent.cmd, args: agent.args, cols, rows, cwd }));
      return id;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return { error: `Failed to spawn "${agent.cmd}": ${message}` };
    }
  });

  ipcMain.on('pty:write', (event, { id, data }) => terminals[id] && terminals[id].write(data));
  ipcMain.on('pty:resize', (event, { id, cols, rows }) => terminals[id] && terminals[id].resize(cols, rows));
  ipcMain.on('pty:kill', (event, { id }) => {
    if (!terminals[id]) return;
    terminals[id].kill();
    delete terminals[id];
  });
}

function killAllTerminals() {
  Object.values(terminals).forEach((processRef) => processRef.kill());
}

module.exports = { registerPtyHandlers, killAllTerminals };
