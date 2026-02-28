const { webContents } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');

const sessions = new Map();
const legacySessionByTermId = new Map();
const sessionIdByRequestId = new Map();
const senderLifecycleBound = new WeakSet();
const MAX_RECENT_OUTPUT_CHUNKS = 120;

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

function randomSessionId() {
  if (typeof crypto.randomUUID === 'function') return `tgclaw-term-${crypto.randomUUID()}`;
  return `tgclaw-term-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function asStringArray(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value == null) return '';
      return String(value);
    })
    .filter(Boolean);
}

function normalizeCommand(command) {
  if (typeof command !== 'string') return '';
  return command.trim();
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeEnvObject(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  Object.entries(value).forEach(([key, rawValue]) => {
    const envKey = typeof key === 'string' ? key.trim() : '';
    if (!envKey) return;
    if (rawValue == null) return;
    out[envKey] = typeof rawValue === 'string' ? rawValue : String(rawValue);
  });
  return out;
}

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

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

function spawnProcess({ cmd, args = [], cols, rows, cwd, env = {} }) {
  prepareSpawnHelper();
  const workingDir = cwd || process.env.HOME;
  if (!workingDir || !fs.existsSync(workingDir)) {
    throw new Error(`Working directory does not exist: ${String(workingDir)}`);
  }

  const processEnv = { ...process.env, TERM: 'xterm-256color', ...normalizeEnvObject(env) };
  const resolvedCmd = resolveCommand(cmd, processEnv.PATH);
  if (!resolvedCmd) {
    throw new Error(`Command not found in PATH: ${cmd}`);
  }

  return pty.spawn(resolvedCmd, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: workingDir,
    env: processEnv,
  });
}

function resolveSpawnSpec(options = {}) {
  const directCommand = normalizeCommand(options.command);
  if (directCommand) {
    return {
      cmd: directCommand,
      args: asStringArray(options.args),
      type: directCommand,
    };
  }

  const type = normalizeCommand(options.type);
  if (!type || type === 'shell') {
    return {
      cmd: normalizeCommand(options.shellCommand) || process.env.SHELL || '/bin/zsh',
      args: asStringArray(options.shellArgs),
      type: 'shell',
    };
  }

  const mapped = agentCommands[type];
  if (mapped) {
    return {
      cmd: mapped.cmd,
      args: asStringArray(mapped.args),
      type,
    };
  }

  return {
    cmd: type,
    args: [],
    type,
  };
}

function serializeSession(session) {
  return {
    terminalSessionId: session.sessionId,
    pid: session.pid,
    projectId: session.projectId,
    requestId: session.requestId,
    runId: session.runId,
    cwd: session.cwd,
    command: session.command,
    args: [...session.args],
    type: session.type,
    titleHint: session.titleHint,
    status: session.status,
    createdAt: session.createdAt,
    exitCode: session.exitCode,
    recentOutput: session.recentOutput.join(''),
  };
}

function safeSendToContentsId(contentsId, channel, payload) {
  const target = webContents.fromId(contentsId);
  if (!target || target.isDestroyed()) return false;
  target.send(channel, payload);
  return true;
}

function detachContentsFromAllSessions(contentsId) {
  sessions.forEach((session) => {
    session.attachedContents.delete(contentsId);
    session.legacyBindings.delete(contentsId);
  });
}

function bindSenderLifecycle(sender) {
  if (!sender || senderLifecycleBound.has(sender)) return;
  senderLifecycleBound.add(sender);
  sender.once('destroyed', () => {
    detachContentsFromAllSessions(sender.id);
    senderLifecycleBound.delete(sender);
  });
}

function attachSessionToSender(session, sender) {
  if (!session || !sender) return;
  bindSenderLifecycle(sender);
  session.attachedContents.add(sender.id);
}

function addLegacyBinding(session, sender, termId) {
  if (!session || !sender || !Number.isInteger(termId)) return;
  bindSenderLifecycle(sender);
  const senderId = sender.id;
  const bindings = session.legacyBindings.get(senderId) || new Set();
  bindings.add(termId);
  session.legacyBindings.set(senderId, bindings);
}

function emitData(session, data) {
  if (typeof data === 'string' && data) {
    session.recentOutput.push(data);
    if (session.recentOutput.length > MAX_RECENT_OUTPUT_CHUNKS) {
      session.recentOutput.splice(0, session.recentOutput.length - MAX_RECENT_OUTPUT_CHUNKS);
    }
  }

  const staleContents = [];
  session.attachedContents.forEach((contentsId) => {
    const ok = safeSendToContentsId(contentsId, `terminal:data:${session.sessionId}`, data);
    if (!ok) staleContents.push(contentsId);
  });
  staleContents.forEach((contentsId) => session.attachedContents.delete(contentsId));

  const staleLegacy = [];
  session.legacyBindings.forEach((termIds, contentsId) => {
    const target = webContents.fromId(contentsId);
    if (!target || target.isDestroyed()) {
      staleLegacy.push(contentsId);
      return;
    }
    termIds.forEach((termId) => {
      target.send(`pty:data:${termId}`, data);
    });
  });
  staleLegacy.forEach((contentsId) => session.legacyBindings.delete(contentsId));
}

function emitExit(session) {
  const payload = {
    terminalSessionId: session.sessionId,
    pid: session.pid,
    exitCode: session.exitCode,
  };

  const staleContents = [];
  session.attachedContents.forEach((contentsId) => {
    const ok = safeSendToContentsId(contentsId, `terminal:exit:${session.sessionId}`, payload);
    if (!ok) staleContents.push(contentsId);
  });
  staleContents.forEach((contentsId) => session.attachedContents.delete(contentsId));

  const staleLegacy = [];
  session.legacyBindings.forEach((termIds, contentsId) => {
    const target = webContents.fromId(contentsId);
    if (!target || target.isDestroyed()) {
      staleLegacy.push(contentsId);
      return;
    }
    termIds.forEach((termId) => target.send(`pty:exit:${termId}`, session.exitCode));
  });
  staleLegacy.forEach((contentsId) => session.legacyBindings.delete(contentsId));
}

function removeLegacyMappingsForSession(sessionId) {
  for (const [termId, mappedSessionId] of legacySessionByTermId.entries()) {
    if (mappedSessionId === sessionId) legacySessionByTermId.delete(termId);
  }
}

function finalizeSessionExit(session, exitCode) {
  session.status = 'exited';
  session.exitCode = Number.isInteger(exitCode) ? exitCode : 0;
  emitExit(session);

  sessions.delete(session.sessionId);
  removeLegacyMappingsForSession(session.sessionId);
  if (session.requestId) sessionIdByRequestId.delete(session.requestId);
}

function createSessionRecord(sender, options = {}) {
  const requestId = normalizeCommand(options.requestId);
  if (requestId && sessionIdByRequestId.has(requestId)) {
    const existingSessionId = sessionIdByRequestId.get(requestId);
    const existing = sessions.get(existingSessionId);
    if (existing) {
      attachSessionToSender(existing, sender);
      return existing;
    }
    sessionIdByRequestId.delete(requestId);
  }

  const spawnSpec = resolveSpawnSpec(options);
  const cwd = normalizeCommand(options.cwd) || process.env.HOME;
  const cols = toFiniteNumber(options.cols, 80);
  const rows = toFiniteNumber(options.rows, 24);
  const processRef = spawnProcess({
    cmd: spawnSpec.cmd,
    args: spawnSpec.args,
    cwd,
    cols,
    rows,
    env: options.env,
  });

  const sessionId = randomSessionId();
  const session = {
    sessionId,
    processRef,
    pid: Number.isInteger(processRef.pid) ? processRef.pid : null,
    projectId: normalizeCommand(options.projectId),
    requestId,
    runId: normalizeCommand(options.runId),
    cwd,
    command: spawnSpec.cmd,
    args: spawnSpec.args,
    type: spawnSpec.type,
    titleHint: normalizeCommand(options.titleHint),
    createdAt: Date.now(),
    status: 'running',
    exitCode: null,
    recentOutput: [],
    attachedContents: new Set(),
    legacyBindings: new Map(),
  };

  attachSessionToSender(session, sender);
  sessions.set(sessionId, session);
  if (requestId) sessionIdByRequestId.set(requestId, sessionId);

  processRef.onData((data) => emitData(session, data));
  processRef.onExit(({ exitCode }) => finalizeSessionExit(session, exitCode));

  const initialInput = typeof options.initialInput === 'string' ? options.initialInput : '';
  if (initialInput) {
    try {
      processRef.write(initialInput);
    } catch {
      // no-op
    }
  }

  return session;
}

function resolveSessionById(sessionId) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return sessions.get(normalized) || null;
}

function resolveLegacySession(termId) {
  const normalizedId = Number(termId);
  if (!Number.isInteger(normalizedId)) return null;
  const sessionId = legacySessionByTermId.get(normalizedId);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) {
    legacySessionByTermId.delete(normalizedId);
    return null;
  }
  return session;
}

function startSessionForLegacy(event, options = {}) {
  const session = createSessionRecord(event.sender, options);
  const termId = nextTermId++;
  legacySessionByTermId.set(termId, session.sessionId);
  addLegacyBinding(session, event.sender, termId);
  return termId;
}

function registerPtyHandlers(ipcMain) {
  ipcMain.handle('terminal:start', (event, options = {}) => {
    try {
      const requestedSessionId = normalizeSessionId(options.terminalSessionId);
      if (requestedSessionId) {
        const existing = resolveSessionById(requestedSessionId);
        if (existing) {
          attachSessionToSender(existing, event.sender);
          return serializeSession(existing);
        }
      }
      const session = createSessionRecord(event.sender, options);
      return serializeSession(session);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return { error: `Failed to start terminal session: ${message}` };
    }
  });

  ipcMain.handle('terminal:attach', (event, options = {}) => {
    const session = resolveSessionById(options.terminalSessionId);
    if (!session) return { error: `Terminal session not found: ${String(options.terminalSessionId || '')}` };
    attachSessionToSender(session, event.sender);
    const cols = toFiniteNumber(options.cols, null);
    const rows = toFiniteNumber(options.rows, null);
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
      try {
        session.processRef.resize(cols, rows);
      } catch {
        // no-op
      }
    }
    return serializeSession(session);
  });

  ipcMain.handle('terminal:status', (event, options = {}) => {
    const session = resolveSessionById(options.terminalSessionId);
    if (!session) return { error: `Terminal session not found: ${String(options.terminalSessionId || '')}` };
    return serializeSession(session);
  });

  ipcMain.on('terminal:input', (event, options = {}) => {
    const session = resolveSessionById(options.terminalSessionId);
    if (!session) return;
    const data = typeof options.data === 'string' ? options.data : String(options.data || '');
    if (!data) return;
    try {
      session.processRef.write(data);
    } catch {
      // no-op
    }
  });

  ipcMain.on('terminal:resize', (event, options = {}) => {
    const session = resolveSessionById(options.terminalSessionId);
    if (!session) return;
    const cols = toFiniteNumber(options.cols, null);
    const rows = toFiniteNumber(options.rows, null);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    try {
      session.processRef.resize(cols, rows);
    } catch {
      // no-op
    }
  });

  ipcMain.on('terminal:kill', (event, options = {}) => {
    const session = resolveSessionById(options.terminalSessionId);
    if (!session) return;
    try {
      session.processRef.kill();
    } catch {
      // no-op
    }
  });

  // Backward-compatible handlers for current renderer/split flow.
  ipcMain.handle('pty:create', (event, { cols, rows, cwd, cmd } = {}) => {
    try {
      return startSessionForLegacy(event, {
        type: 'shell',
        command: normalizeCommand(cmd),
        cwd,
        cols,
        rows,
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return { error: `Failed to spawn shell: ${message}` };
    }
  });

  ipcMain.handle('agent:spawn', (event, { type, cwd, cols, rows } = {}) => {
    try {
      return startSessionForLegacy(event, {
        type,
        cwd,
        cols,
        rows,
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const normalizedType = normalizeCommand(type) || 'unknown';
      return { error: `Failed to spawn "${normalizedType}": ${message}` };
    }
  });

  ipcMain.handle('pty:spawn-command', (event, { command, args = [], cwd, cols, rows } = {}) => {
    const normalizedCommand = normalizeCommand(command);
    try {
      if (!normalizedCommand) throw new Error('Command is required');
      return startSessionForLegacy(event, {
        command: normalizedCommand,
        args,
        cwd,
        cols,
        rows,
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return { error: `Failed to spawn command "${normalizedCommand || 'unknown'}": ${message}` };
    }
  });

  ipcMain.on('pty:write', (event, { id, data } = {}) => {
    const session = resolveLegacySession(id);
    if (!session) return;
    const text = typeof data === 'string' ? data : String(data || '');
    if (!text) return;
    try {
      session.processRef.write(text);
    } catch {
      // no-op
    }
  });

  ipcMain.on('pty:resize', (event, { id, cols, rows } = {}) => {
    const session = resolveLegacySession(id);
    if (!session) return;
    const nextCols = toFiniteNumber(cols, null);
    const nextRows = toFiniteNumber(rows, null);
    if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) return;
    try {
      session.processRef.resize(nextCols, nextRows);
    } catch {
      // no-op
    }
  });

  ipcMain.on('pty:kill', (event, { id } = {}) => {
    const session = resolveLegacySession(id);
    if (!session) return;
    try {
      session.processRef.kill();
    } catch {
      // no-op
    }
  });
}

function killAllTerminals() {
  sessions.forEach((session) => {
    try {
      session.processRef.kill();
    } catch {
      // no-op
    }
  });
  sessions.clear();
  legacySessionByTermId.clear();
  sessionIdByRequestId.clear();
}

module.exports = { registerPtyHandlers, killAllTerminals };
