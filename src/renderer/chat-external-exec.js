import { addAgentTab } from './tabs.js';
import { state } from './state.js';
import { selectItem } from './sidebar.js';
import { isChatItemId } from './utils.js';
const MAX_RECURSIVE_SPEC_DEPTH = 3;
const MAX_COMMAND_TEXT_LENGTH = 8192;
const COMMAND_SUGGESTION_KEYS = ['command', 'cmd', 'program', 'binary', 'executable'];
const MAX_CAPTURED_EXTERNAL_EXECUTIONS = 400;
const pendingExternalExecCalls = new Map();
const capturedExternalExecutionKeys = [];
const capturedExternalExecutionSet = new Set();
function trimToString(value) { return typeof value === 'string' ? value.trim() : ''; }
function normalizeExternalAgentType(command) {
  const normalized = trimToString(command);
  if (!normalized) return 'shell';
  const segments = normalized.split(/[\\/]/);
  const binary = segments[segments.length - 1].toLowerCase();
  if (binary === 'claude') return 'claude-code';
  if (binary === 'codex') return 'codex';
  if (binary === 'opencode') return 'opencode';
  if (binary === 'gemini') return 'gemini';
  if (binary === 'kimi') return 'kimi';
  if (binary === 'goose') return 'goose';
  if (binary === 'aider') return 'aider';
  return 'shell';
}
export function parseCommandArgs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item : (item == null ? '' : String(item)))).filter(Boolean);
}
export function parseCommandStringWithArgs(value) {
  if (typeof value !== 'string') return { command: '', args: [] };
  const text = value.trim();
  if (!text) return { command: '', args: [] };
  const rawParts = text.match(/(?:[^\s"]+|"([^"]*)"|'([^']*)')+/g);
  if (!rawParts) return { command: text, args: [] };
  const parts = rawParts.map((part) => {
    if (part.startsWith('"') && part.endsWith('"')) return part.slice(1, -1);
    if (part.startsWith("'") && part.endsWith("'")) return part.slice(1, -1);
    return part;
  }).filter(Boolean);
  if (parts.length === 0) return { command: '', args: [] };
  return { command: parts[0], args: parts.slice(1) };
}
export function normalizeToolArguments(value) {
  if (!value) return {};
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function extractMessageContent(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('');
  return '';
}
function parseExternalExecToolCalls(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return [];
  return message.content.map((item) => {
    const type = trimToString(item?.type).toLowerCase();
    if (!['toolcall', 'tool_call', 'tooluse', 'tool_use'].includes(type)) return null;
    const name = trimToString(item?.name || item?.toolName).toLowerCase();
    if (name !== 'exec') return null;
    const toolCallId = trimToString(item?.id || item?.toolCallId || item?.tool_use_id);
    const args = normalizeToolArguments(item?.arguments);
    const commandText = trimToString(args.command);
    const parsed = parseCommandStringWithArgs(commandText);
    const command = trimToString(parsed.command);
    if (!command) return null;
    return { toolCallId, command, args: parseCommandArgs(parsed.args), cwd: normalizeProjectPath(trimToString(args.workdir || args.cwd)), rawCommand: commandText };
  }).filter(Boolean);
}
function parseExternalExecToolResult(message) {
  if (!message || typeof message !== 'object') return null;
  const role = trimToString(message.role).toLowerCase();
  if (role !== 'toolresult') return null;
  const toolName = trimToString(message.toolName || message.name).toLowerCase();
  if (toolName !== 'exec') return null;
  const text = extractMessageContent(message);
  const details = message.details && typeof message.details === 'object' ? message.details : {};
  const sessionMatch = typeof text === 'string' ? text.match(/session\s+([a-z0-9._:-]+)/i) : null;
  const pidMatch = typeof text === 'string' ? text.match(/pid\s+(\d+)/i) : null;
  const exitMatch = typeof text === 'string' ? text.match(/exited with code\s+(-?\d+)/i) : null;
  const sessionId = trimToString(details.sessionId || (sessionMatch ? sessionMatch[1] : ''));
  const pidCandidate = Number(details.pid);
  const pid = Number.isInteger(pidCandidate) && pidCandidate > 0 ? pidCandidate : (pidMatch ? Number(pidMatch[1]) : null);
  const exitCandidate = Number(details.exitCode);
  const exitCode = Number.isInteger(exitCandidate) ? exitCandidate : (exitMatch ? Number(exitMatch[1]) : null);
  return { toolCallId: trimToString(message.toolCallId || message.tool_call_id), sessionId, pid: Number.isInteger(pid) ? pid : null, exitCode: Number.isInteger(exitCode) ? exitCode : null, output: text };
}
function trimCapturedExternalExecutionKeys() {
  while (capturedExternalExecutionKeys.length > MAX_CAPTURED_EXTERNAL_EXECUTIONS) {
    const removed = capturedExternalExecutionKeys.shift();
    if (removed) capturedExternalExecutionSet.delete(removed);
  }
}
function rememberCapturedExternalExecution(key) {
  if (!key || capturedExternalExecutionSet.has(key)) return;
  capturedExternalExecutionSet.add(key);
  capturedExternalExecutionKeys.push(key);
  trimCapturedExternalExecutionKeys();
}
function capturedExecutionKey(result) {
  if (result?.sessionId) return `session:${result.sessionId}`;
  if (result?.toolCallId) return `tool:${result.toolCallId}`;
  if (Number.isInteger(result?.pid)) return `pid:${result.pid}`;
  return '';
}
async function launchCapturedExternalExecution(toolCall, result) {
  if (!toolCall || !result) return;
  const key = capturedExecutionKey(result);
  if (key && capturedExternalExecutionSet.has(key)) return;
  const project = resolveProjectForCliSpec({ projectId: '', cwd: toolCall.cwd, projectPath: toolCall.cwd });
  if (!project) return;
  const externalSessionId = result.sessionId ? `external:${result.sessionId}` : `external:${Date.now()}`;
  const type = normalizeExternalAgentType(toolCall.command);
  const statusText = Number.isInteger(result.exitCode) ? `completed (exit ${result.exitCode})` : 'running';
  await addAgentTab(type, { projectId: project.id, terminalSessionId: externalSessionId, captureExecution: { source: 'openclaw-exec', sessionId: result.sessionId, pid: result.pid, command: toolCall.command, args: toolCall.args, cwd: toolCall.cwd || project.cwd, status: statusText, output: result.output || '', exited: Number.isInteger(result.exitCode), exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null } });
  rememberCapturedExternalExecution(key || `fallback:${externalSessionId}`);
  pendingExternalExecCalls.delete(toolCall.toolCallId);
  if (isChatItemId(state.currentItem)) selectItem(project.id);
}
export function captureExternalExecutionEvidence(frame) {
  const message = frame?.message;
  if (!message || typeof message !== 'object') return;
  parseExternalExecToolCalls(message).forEach((call) => { if (call.toolCallId) pendingExternalExecCalls.set(call.toolCallId, call); });
  const result = parseExternalExecToolResult(message);
  if (!result?.toolCallId) return;
  const toolCall = pendingExternalExecCalls.get(result.toolCallId);
  if (toolCall) void launchCapturedExternalExecution(toolCall, result);
}
function extractCommandSpecFromText(value) {
  const text = trimToString(value);
  if (!text || text.length > MAX_COMMAND_TEXT_LENGTH || !text.startsWith('{') || !text.endsWith('}')) return null;
  try { return parseCommandSpecFromValue(JSON.parse(text)); } catch { return null; }
}
function parseCommandSpecFromValue(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > MAX_RECURSIVE_SPEC_DEPTH) return null;
  const command = COMMAND_SUGGESTION_KEYS.map((key) => trimToString(value[key])).find(Boolean);
  if (command) {
    const inline = parseCommandStringWithArgs(command);
    return { command: inline.command || command, args: inline.args.length > 0 ? inline.args : parseCommandArgs(value.args || value.argv || value.params || value.arguments), cwd: trimToString(value.cwd), projectId: trimToString(value.projectId), projectPath: trimToString(value.projectPath), workingDir: trimToString(value.workingDir) };
  }
  const candidate = trimToString(value.action) || trimToString(value.type) || trimToString(value.name);
  const action = trimToString(value.exec) || trimToString(value.tool) || trimToString(value.commandSource);
  const candidateLower = candidate.toLowerCase();
  if ((candidateLower === 'exec' || candidateLower === 'execute') && action) {
    const inline = parseCommandStringWithArgs(action);
    return parseCommandSpecFromValue({ command: inline.command || action, args: inline.args.length > 0 ? inline.args : value.args || value.argv || value.params || value.arguments, cwd: value.cwd, projectId: value.projectId, projectPath: value.projectPath, workingDir: value.workingDir }, depth + 1);
  }
  const nested = value.meta || value.metadata || value.payload || value.data || value.details;
  if (nested && typeof nested === 'object') {
    const nestedSpec = parseCommandSpecFromValue(nested, depth + 1);
    if (nestedSpec) return nestedSpec;
  }
  return extractCommandSpecFromText(trimToString(value.text) || trimToString(value.content)) || extractCommandSpecFromText(trimToString(value.commandJson));
}
export function normalizeProjectPath(value) {
  const path = trimToString(value);
  return path ? path.replace(/[/\\]+$/, '') : '';
}
export function parseCliLaunchSpec(frame) {
  const candidates = [frame, frame?.message, frame?.tool, frame?.toolCall, frame?.event, frame?.data, frame?.params, frame?.metadata, frame?.meta].filter(Boolean);
  for (const candidate of candidates) {
    const spec = parseCommandSpecFromValue(candidate);
    if (spec) return spec;
    const textSpec = extractCommandSpecFromText(candidate?.text || candidate?.content);
    if (textSpec) return textSpec;
  }
  return null;
}
export function normalizeCommandSpecSpecFrame(frame) {
  if (!frame) return null;
  const spec = parseCliLaunchSpec(frame);
  if (!spec?.command) return null;
  return { command: trimToString(spec.command), args: parseCommandArgs(spec.args), cwd: normalizeProjectPath(trimToString(spec.cwd || spec.workingDir || spec.working_directory || spec.projectPath)), projectId: trimToString(spec.projectId), projectPath: normalizeProjectPath(trimToString(spec.projectPath || spec.directory || spec.projectRoot)) };
}
export function resolveProjectForCliSpec(spec) {
  if (spec.projectId) {
    const byId = state.projects.find((project) => project.id === spec.projectId);
    if (byId) return byId;
  }
  const targetPaths = [normalizeProjectPath(spec.cwd), normalizeProjectPath(spec.projectPath)].filter(Boolean);
  if (targetPaths.length > 0) {
    const direct = state.projects.find((project) => {
      const projectCwd = normalizeProjectPath(project.cwd);
      return targetPaths.includes(projectCwd) || targetPaths.some((path) => projectCwd.startsWith(path));
    });
    if (direct) return direct;
  }
  const currentProject = state.projects.find((project) => project.id === state.currentItem);
  return currentProject || state.projects[0];
}
