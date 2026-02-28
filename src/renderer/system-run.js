import { gateway } from './gateway.js';
import { state } from './state.js';
import { addAgentTab } from './tabs.js';

const activeRuns = new Map();

const EXEC_APPROVALS_KEY = 'tgclaw.execApprovals.v1';

function loadExecApprovals() {
  try {
    const raw = localStorage.getItem(EXEC_APPROVALS_KEY);
    if (!raw) return { allowlist: [] };
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { allowlist: [] };
  } catch {
    return { allowlist: [] };
  }
}

function saveExecApprovals(file) {
  try {
    localStorage.setItem(EXEC_APPROVALS_KEY, JSON.stringify(file));
  } catch {
    // ignore
  }
}

function hashExecApprovals(file) {
  const str = JSON.stringify(file || {});
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

async function handleExecApprovalsGet(requestId, nodeId) {
  try {
    const file = loadExecApprovals();
    const hash = hashExecApprovals(file);
    await gateway.nodeInvokeResult(requestId, nodeId, true, {
      path: 'localStorage:' + EXEC_APPROVALS_KEY,
      exists: true,
      hash,
      file,
    }, null);
  } catch (err) {
    await gateway.nodeInvokeResult(requestId, nodeId, false, null, {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleExecApprovalsSet(requestId, nodeId, paramsJSON) {
  try {
    const params = typeof paramsJSON === 'string' ? JSON.parse(paramsJSON) : paramsJSON;
    if (!params || !params.file || typeof params.file !== 'object') {
      await gateway.nodeInvokeResult(requestId, nodeId, false, null, {
        code: 'INVALID_REQUEST',
        message: 'exec approvals file required',
      });
      return;
    }

    const currentFile = loadExecApprovals();
    const currentHash = hashExecApprovals(currentFile);

    if (params.baseHash && params.baseHash !== currentHash) {
      await gateway.nodeInvokeResult(requestId, nodeId, false, null, {
        code: 'CONFLICT',
        message: `exec approvals modified (expected ${params.baseHash}, got ${currentHash})`,
      });
      return;
    }

    const newFile = params.file;
    saveExecApprovals(newFile);
    const newHash = hashExecApprovals(newFile);

    await gateway.nodeInvokeResult(requestId, nodeId, true, {
      path: 'localStorage:' + EXEC_APPROVALS_KEY,
      exists: true,
      hash: newHash,
      file: newFile,
    }, null);
  } catch (err) {
    await gateway.nodeInvokeResult(requestId, nodeId, false, null, {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function trimToString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProjectPath(value) {
  const path = trimToString(value);
  return path ? path.replace(/[\/\\]+$/, '') : '';
}

function resolveProjectForCwd(cwd) {
  const normalizedCwd = normalizeProjectPath(cwd);
  if (!normalizedCwd) return state.projects[0];

  const match = state.projects.find((project) => {
    const projectCwd = normalizeProjectPath(project.cwd);
    return projectCwd === normalizedCwd || normalizedCwd.startsWith(projectCwd + '/');
  });
  return match || state.projects[0];
}

function detectAgentType(command) {
  const normalized = trimToString(command).toLowerCase();
  const segments = normalized.split(/[\/\\]/);
  const binary = segments[segments.length - 1];

  const agentMap = {
    'claude': 'claude-code',
    'codex': 'codex',
    'opencode': 'opencode',
    'gemini': 'gemini',
    'kimi': 'kimi',
    'goose': 'goose',
    'aider': 'aider',
  };
  return agentMap[binary] || 'shell';
}

function parseSystemRunParams(paramsJSON) {
  if (!paramsJSON) return null;
  try {
    const params = typeof paramsJSON === 'string' ? JSON.parse(paramsJSON) : paramsJSON;
    if (!params || typeof params !== 'object') return null;
    return {
      command: trimToString(params.command) || trimToString(params.rawCommand),
      cwd: normalizeProjectPath(params.cwd),
      env: params.env && typeof params.env === 'object' ? params.env : {},
      timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : 300000,
      agentId: trimToString(params.agentId),
      sessionKey: trimToString(params.sessionKey),
      runId: trimToString(params.runId),
    };
  } catch {
    return null;
  }
}

function parseCommandToArgv(command) {
  if (!command) return { binary: '', args: [] };
  const parts = command.match(/(?:[^\s"]+|"([^"]*)")+/g) || [];
  const cleaned = parts.map((part) => {
    if (part.startsWith('"') && part.endsWith('"')) return part.slice(1, -1);
    return part;
  }).filter(Boolean);
  return { binary: cleaned[0] || '', args: cleaned.slice(1) };
}

async function handleSystemRun(request) {
  const { id: requestId, nodeId, command, paramsJSON } = request;

  if (command === 'system.execApprovals.get') {
    await handleExecApprovalsGet(requestId, nodeId);
    return;
  }

  if (command === 'system.execApprovals.set') {
    await handleExecApprovalsSet(requestId, nodeId, paramsJSON);
    return;
  }

  if (command !== 'system.run') {
    await gateway.nodeInvokeResult(requestId, nodeId, false, null, {
      code: 'UNSUPPORTED_COMMAND',
      message: `Unsupported command: ${command}`,
    });
    return;
  }

  const params = parseSystemRunParams(paramsJSON);
  if (!params || !params.command) {
    await gateway.nodeInvokeResult(requestId, nodeId, false, null, {
      code: 'INVALID_PARAMS',
      message: 'Missing required command parameter',
    });
    return;
  }

  const { binary, args } = parseCommandToArgv(params.command);
  const agentType = detectAgentType(binary);
  const project = resolveProjectForCwd(params.cwd);

  if (!project) {
    await gateway.nodeInvokeResult(requestId, nodeId, false, null, {
      code: 'NO_PROJECT',
      message: 'No project found for the specified working directory',
    });
    return;
  }

  const terminalSessionId = `system-run:${requestId}`;

  try {
    const tabResult = await addAgentTab(agentType, {
      projectId: project.id,
      command: binary,
      commandArgs: args,
      terminalSessionId,
      terminalRequest: {
        command: binary,
        args,
        cwd: params.cwd || project.cwd,
        env: params.env,
        requestId,
      },
    });

    activeRuns.set(requestId, {
      terminalSessionId,
      projectId: project.id,
      startedAt: Date.now(),
      command: params.command,
    });

    await gateway.nodeInvokeResult(requestId, nodeId, true, {
      status: 'started',
      terminalSessionId,
      projectId: project.id,
      command: params.command,
    }, null);

  } catch (err) {
    await gateway.nodeInvokeResult(requestId, nodeId, false, null, {
      code: 'LAUNCH_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function setupSystemRunHandler() {
  gateway.on('node.invoke.request', (payload) => {
    void handleSystemRun(payload);
  });
}

export function getActiveRun(requestId) {
  return activeRuns.get(requestId);
}

export function clearActiveRun(requestId) {
  activeRuns.delete(requestId);
}

export { handleSystemRun, detectAgentType, resolveProjectForCwd };
