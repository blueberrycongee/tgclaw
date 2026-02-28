import { appendMessage } from './chat-messages.js';
import { state } from './state.js';
import { gateway } from './gateway.js';
import { selectItem } from './sidebar.js';
import { addAgentTab } from './tabs.js';
import { isChatItemId } from './utils.js';
import { normalizeCommandSpecSpecFrame, normalizeProjectPath, parseCommandArgs, resolveProjectForCliSpec } from './chat-external-exec.js';

export const ENABLE_CHAT_TEXT_COMMAND_FALLBACK = false;
const MAX_HANDLED_TERMINAL_REQUESTS = 400;
const handledTerminalRequestKeys = [];
const handledTerminalRequestSet = new Set();
const cliLaunchByRun = new Map();

function trimToString(value) { return typeof value === 'string' ? value.trim() : ''; }

export async function spawnCliFromGatewayFrame(frame, runKey) {
  const spec = normalizeCommandSpecSpecFrame(frame);
  if (!spec) return;
  const dedupeKey = `${runKey}:${spec.command}:${(spec.args || []).join('\u001F')}`;
  if (cliLaunchByRun.has(dedupeKey)) return;
  cliLaunchByRun.set(dedupeKey, true);
  const project = resolveProjectForCliSpec(spec);
  if (!project) {
    if (isChatItemId(state.currentItem)) appendMessage('Failed to auto-launch CLI from chat: no project context found.', 'from-bot message-error');
    return;
  }
  try {
    await addAgentTab(spec.command, { command: spec.command, commandArgs: spec.args, projectId: project.id });
  } catch {
    // Keep stream behavior unchanged; terminal creation errors are surfaced in terminal UI.
  }
}

export function clearCliLaunchStateByRun(runKey) {
  const prefix = `${runKey}:`;
  for (const key of cliLaunchByRun.keys()) if (key.startsWith(prefix)) cliLaunchByRun.delete(key);
}

export function clearAllCliLaunchState() { cliLaunchByRun.clear(); }

function trimHandledTerminalRequestKeys() {
  while (handledTerminalRequestKeys.length > MAX_HANDLED_TERMINAL_REQUESTS) {
    const removed = handledTerminalRequestKeys.shift();
    if (removed) handledTerminalRequestSet.delete(removed);
  }
}

function rememberHandledTerminalRequest(key) {
  if (!key || handledTerminalRequestSet.has(key)) return;
  handledTerminalRequestSet.add(key);
  handledTerminalRequestKeys.push(key);
  trimHandledTerminalRequestKeys();
}

function terminalRequestKey(payload) {
  const requestId = trimToString(payload?.requestId);
  if (requestId) return `request:${requestId}`;
  const runId = trimToString(payload?.runId) || 'norun';
  const command = trimToString(payload?.command) || 'shell';
  const args = parseCommandArgs(payload?.args).join('\u001F');
  const project = trimToString(payload?.projectId) || normalizeProjectPath(payload?.cwd) || 'noproject';
  return `run:${runId}:${project}:${command}:${args}`;
}

function normalizeTerminalStartPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const args = parseCommandArgs(payload.args);
  const cols = Number(payload.cols);
  const rows = Number(payload.rows);
  return {
    requestId: trimToString(payload.requestId), runId: trimToString(payload.runId), projectId: trimToString(payload.projectId), cwd: normalizeProjectPath(trimToString(payload.cwd)), command: trimToString(payload.command), args,
    titleHint: trimToString(payload.titleHint), env: payload.env && typeof payload.env === 'object' ? payload.env : {}, cols: Number.isFinite(cols) ? cols : undefined, rows: Number.isFinite(rows) ? rows : undefined, autoAttach: payload.autoAttach !== false,
    initialInput: typeof payload.initialInput === 'string' ? payload.initialInput : '', terminalSessionId: trimToString(payload.terminalSessionId),
  };
}

async function notifyGatewayTerminalRequestStarted(request, terminalSession) {
  const terminalSessionId = trimToString(terminalSession?.terminalSessionId);
  if (!terminalSessionId || !gateway.connected) return;
  try {
    await gateway.send('terminal.request.started', {
      requestId: request.requestId || undefined, runId: request.runId || undefined, terminalSessionId,
      pid: Number.isInteger(terminalSession?.pid) ? terminalSession.pid : undefined, projectId: request.projectId || undefined,
    });
  } catch {
    // no-op
  }
}

async function notifyGatewayTerminalRequestFailed(request, reason, message) {
  if (!gateway.connected) return;
  try {
    await gateway.send('terminal.request.failed', {
      requestId: request.requestId || undefined, runId: request.runId || undefined,
      reason: trimToString(reason) || 'start_failed', message: trimToString(message) || 'Terminal start failed',
    });
  } catch {
    // no-op
  }
}

function resolveProjectForTerminalRequest(request) {
  return resolveProjectForCliSpec({ projectId: request.projectId, cwd: request.cwd, projectPath: request.cwd });
}

async function startTerminalFromGatewayRequest(request) {
  const key = terminalRequestKey(request);
  if (handledTerminalRequestSet.has(key)) return;
  const project = resolveProjectForTerminalRequest(request);
  if (!project) {
    rememberHandledTerminalRequest(key);
    if (isChatItemId(state.currentItem)) appendMessage('Failed to start terminal from gateway request: no project found.', 'from-bot message-error');
    await notifyGatewayTerminalRequestFailed(request, 'project_not_found', 'No matching project for terminal request');
    return;
  }
  try {
    const tab = await addAgentTab(request.command || 'shell', {
      projectId: project.id, command: request.command, commandArgs: request.args, terminalSessionId: request.terminalSessionId,
      terminalRequest: { ...request, projectId: request.projectId || project.id, cwd: request.cwd || project.cwd },
    });
    rememberHandledTerminalRequest(key);
    if (request.autoAttach) selectItem(project.id);
    await notifyGatewayTerminalRequestStarted(request, tab);
  } catch (error) {
    rememberHandledTerminalRequest(key);
    const message = error instanceof Error ? error.message : 'Terminal start failed';
    if (isChatItemId(state.currentItem)) appendMessage(`Failed to start terminal: ${message}`, 'from-bot message-error');
    await notifyGatewayTerminalRequestFailed(request, 'start_failed', message);
  }
}

export function handleGatewayEventFrame(frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.event === 'terminal.request.start') {
    const request = normalizeTerminalStartPayload(frame.payload);
    if (request) void startTerminalFromGatewayRequest(request);
    return;
  }
  if (frame.event === 'terminal.request.started') {
    const request = normalizeTerminalStartPayload(frame.payload);
    if (request?.terminalSessionId) void startTerminalFromGatewayRequest(request);
    return;
  }
  if (frame.event === 'terminal.request.failed') {
    const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {};
    const message = trimToString(payload.message) || 'Terminal request failed.';
    if (isChatItemId(state.currentItem)) appendMessage(message, 'from-bot message-error');
  }
}
