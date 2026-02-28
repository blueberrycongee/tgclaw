const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

const terminals = {};
let nextTermId = 1;
let spawnHelperPrepared = false;

const agentCommands = {
  'claude-code': { cmd: 'claude', args: [] },
  codex: { cmd: 'codex', args: [] },
  opencode: { cmd: 'opencode', args: [] },
  gemini: { cmd: 'gemini', args: [] },
  kimi: { cmd: 'kimi', args: [] },
  goose: { cmd: 'goose', args: [] },
  aider: { cmd: 'aider', args: [] },
};

function asarVariants(filePath) {
  const variants = [filePath];
  if (filePath.includes('.asar/')) variants.push(filePath.replace('.asar/', '.asar.unpacked/'));
  return variants;
}

function ensureExecutable(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    try {
      fs.chmodSync(filePath, 0o755);
      return true;
    } catch (error) {
      console.warn(`Failed to chmod +x ${filePath}:`, error);
      return false;
    }
  }
}

function prepareSpawnHelper() {
  if (spawnHelperPrepared || process.platform !== 'darwin') return;
  spawnHelperPrepared = true;

  try {
    const packageRoot = path.dirname(require.resolve('node-pty/package.json'));
    const candidates = [
      path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
      path.join(packageRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
      path.join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      path.join(packageRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    ];
    const checked = new Set();
    for (const candidate of candidates) {
      for (const variant of asarVariants(candidate)) {
        if (checked.has(variant)) continue;
        checked.add(variant);
        if (ensureExecutable(variant)) return;
      }
    }
  } catch (error) {
    console.warn('Failed to prepare node-pty spawn-helper:', error);
  }
}

function resolveCommand(cmd, envPath) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (cmd.includes('/')) {
    return fs.existsSync(cmd) ? cmd : null;
  }

  const pathValue = typeof envPath === 'string' ? envPath : '';
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  for (const segment of segments) {
    const candidate = path.join(segment, cmd);
    if (!fs.existsSync(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching another PATH segment.
    }
  }
  return null;
}

function spawnProcess({ cmd, args = [], cols, rows, cwd }) {
  prepareSpawnHelper();
  const workingDir = cwd || process.env.HOME;
  if (!workingDir || !fs.existsSync(workingDir)) {
    throw new Error(`Working directory does not exist: ${String(workingDir)}`);
  }

  const env = { ...process.env, TERM: 'xterm-256color' };

  const resolvedCmd = resolveCommand(cmd, env.PATH);
  if (!resolvedCmd) {
    throw new Error(`Command not found in PATH: ${cmd}`);
  }

  return pty.spawn(resolvedCmd, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: workingDir,
    env,
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
    try {
      const processRef = spawnProcess({ cmd: cmd || process.env.SHELL || '/bin/zsh', cols, rows, cwd });
      bindTerminal(event, id, processRef);
      return id;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return { error: `Failed to spawn shell: ${message}` };
    }
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
