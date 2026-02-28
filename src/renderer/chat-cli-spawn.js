const MAX_RECURSIVE_SPEC_DEPTH = 3; const MAX_COMMAND_TEXT_LENGTH = 8192;
const COMMAND_SUGGESTION_KEYS = ['command', 'cmd', 'program', 'binary', 'executable']; const MAX_CAPTURED_EXTERNAL_EXECUTIONS = 400;
export function createChatCliSpawn(deps) {
  const { state, addAgentTab, appendMessage, isChatItemId, selectItem, extractMessageContent } = deps;
  const cliLaunchByRun = new Map();
  const pendingExternalExecCalls = new Map();
  const capturedExternalExecutionKeys = [];
  const capturedExternalExecutionSet = new Set();
  const trimToString = (value) => (typeof value === 'string' ? value.trim() : '');
  const parseCommandArgs = (value) => (Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : (item == null ? '' : String(item)))).filter(Boolean) : []);
  const normalizeProjectPath = (value) => {
    const path = trimToString(value);
    return path ? path.replace(/[/\\]+$/, '') : '';
  };
  const parseCommandStringWithArgs = (value) => {
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
    return parts.length ? { command: parts[0], args: parts.slice(1) } : { command: '', args: [] };
  };
  const normalizeToolArguments = (value) => {
    if (!value) return {};
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  const normalizeExternalAgentType = (command) => {
    const normalized = trimToString(command);
    if (!normalized) return 'shell';
    const binary = normalized.split(/[\\/]/).pop().toLowerCase();
    const map = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', gemini: 'gemini', kimi: 'kimi', goose: 'goose', aider: 'aider' };
    return map[binary] || 'shell';
  };
  const parseExternalExecToolCalls = (message) => {
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
  };
  const parseExternalExecToolResult = (message) => {
    if (!message || typeof message !== 'object') return null;
    if (trimToString(message.role).toLowerCase() !== 'toolresult') return null;
    if (trimToString(message.toolName || message.name).toLowerCase() !== 'exec') return null;
    const text = extractMessageContent(message);
    const details = message.details && typeof message.details === 'object' ? message.details : {};
    const sessionMatch = typeof text === 'string' ? text.match(/session\s+([a-z0-9._:-]+)/i) : null;
    const pidMatch = typeof text === 'string' ? text.match(/pid\s+(\d+)/i) : null;
    const exitMatch = typeof text === 'string' ? text.match(/exited with code\s+(-?\d+)/i) : null;
    const pidCandidate = Number(details.pid);
    const exitCandidate = Number(details.exitCode);
    const pid = Number.isInteger(pidCandidate) && pidCandidate > 0 ? pidCandidate : (pidMatch ? Number(pidMatch[1]) : null);
    const exitCode = Number.isInteger(exitCandidate) ? exitCandidate : (exitMatch ? Number(exitMatch[1]) : null);
    return {
      toolCallId: trimToString(message.toolCallId || message.tool_call_id),
      sessionId: trimToString(details.sessionId || (sessionMatch ? sessionMatch[1] : '')),
      pid: Number.isInteger(pid) ? pid : null,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      output: text,
    };
  };
  const trimCapturedExternalExecutionKeys = () => {
    while (capturedExternalExecutionKeys.length > MAX_CAPTURED_EXTERNAL_EXECUTIONS) {
      const removed = capturedExternalExecutionKeys.shift();
      if (removed) capturedExternalExecutionSet.delete(removed);
    }
  };
  const rememberCapturedExternalExecution = (key) => {
    if (!key || capturedExternalExecutionSet.has(key)) return;
    capturedExternalExecutionSet.add(key);
    capturedExternalExecutionKeys.push(key);
    trimCapturedExternalExecutionKeys();
  };
  const capturedExecutionKey = (result) => (result?.sessionId ? `session:${result.sessionId}` : (result?.toolCallId ? `tool:${result.toolCallId}` : (Number.isInteger(result?.pid) ? `pid:${result.pid}` : '')));
  function resolveProjectForCliSpec(spec) {
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
    return state.projects.find((project) => project.id === state.currentItem) || state.projects[0];
  }
  async function launchCapturedExternalExecution(toolCall, result) {
    if (!toolCall || !result) return;
    const key = capturedExecutionKey(result);
    if (key && capturedExternalExecutionSet.has(key)) return;
    const project = resolveProjectForCliSpec({ projectId: '', cwd: toolCall.cwd, projectPath: toolCall.cwd });
    if (!project) return;
    const externalSessionId = result.sessionId ? `external:${result.sessionId}` : `external:${Date.now()}`;
    const statusText = Number.isInteger(result.exitCode) ? `completed (exit ${result.exitCode})` : 'running';
    await addAgentTab(normalizeExternalAgentType(toolCall.command), {
      projectId: project.id,
      terminalSessionId: externalSessionId,
      captureExecution: { source: 'openclaw-exec', sessionId: result.sessionId, pid: result.pid, command: toolCall.command, args: toolCall.args, cwd: toolCall.cwd || project.cwd, status: statusText, output: result.output || '', exited: Number.isInteger(result.exitCode), exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null },
    });
    rememberCapturedExternalExecution(key || `fallback:${externalSessionId}`);
    pendingExternalExecCalls.delete(toolCall.toolCallId);
    if (isChatItemId(state.currentItem)) selectItem(project.id);
  }
  function captureExternalExecutionEvidence(frame) {
    const message = frame?.message;
    if (!message || typeof message !== 'object') return;
    parseExternalExecToolCalls(message).forEach((call) => { if (call.toolCallId) pendingExternalExecCalls.set(call.toolCallId, call); });
    const result = parseExternalExecToolResult(message);
    if (!result?.toolCallId) return;
    const toolCall = pendingExternalExecCalls.get(result.toolCallId);
    if (toolCall) void launchCapturedExternalExecution(toolCall, result);
  }
  const extractCommandSpecFromText = (value) => {
    const text = trimToString(value);
    if (!text || text.length > MAX_COMMAND_TEXT_LENGTH || !text.startsWith('{') || !text.endsWith('}')) return null;
    try { return parseCommandSpecFromValue(JSON.parse(text)); } catch { return null; }
  };
  const parseCommandSpecFromValue = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > MAX_RECURSIVE_SPEC_DEPTH) return null;
    const command = COMMAND_SUGGESTION_KEYS.map((key) => trimToString(value[key])).find(Boolean);
    if (command) {
      const inlineParts = parseCommandStringWithArgs(command);
      return { command: inlineParts.command || command, args: inlineParts.args.length ? inlineParts.args : parseCommandArgs(value.args || value.argv || value.params || value.arguments), cwd: trimToString(value.cwd), projectId: trimToString(value.projectId), projectPath: trimToString(value.projectPath), workingDir: trimToString(value.workingDir) };
    }
    const candidate = trimToString(value.action) || trimToString(value.type) || trimToString(value.name);
    const action = trimToString(value.exec) || trimToString(value.tool) || trimToString(value.commandSource);
    if ((candidate.toLowerCase() === 'exec' || candidate.toLowerCase() === 'execute') && action) {
      const inlineParts = parseCommandStringWithArgs(action);
      return parseCommandSpecFromValue({ command: inlineParts.command || action, args: inlineParts.args.length ? inlineParts.args : value.args || value.argv || value.params || value.arguments, cwd: value.cwd, projectId: value.projectId, projectPath: value.projectPath, workingDir: value.workingDir }, depth + 1);
    }
    const nested = value.meta || value.metadata || value.payload || value.data || value.details;
    if (nested && typeof nested === 'object') {
      const nestedSpec = parseCommandSpecFromValue(nested, depth + 1);
      if (nestedSpec) return nestedSpec;
    }
    return extractCommandSpecFromText(trimToString(value.text) || trimToString(value.content)) || (trimToString(value.commandJson) ? extractCommandSpecFromText(trimToString(value.commandJson)) : null);
  };
  const parseCliLaunchSpec = (frame) => {
    const candidates = [frame, frame?.message, frame?.tool, frame?.toolCall, frame?.event, frame?.data, frame?.params, frame?.metadata, frame?.meta].filter(Boolean);
    for (const candidate of candidates) {
      const spec = parseCommandSpecFromValue(candidate);
      if (spec) return spec;
      const textSpec = extractCommandSpecFromText(candidate?.text || candidate?.content);
      if (textSpec) return textSpec;
    }
    return null;
  };
  const normalizeCommandSpecFrame = (frame) => {
    if (!frame) return null;
    const spec = parseCliLaunchSpec(frame);
    if (!spec?.command) return null;
    return { command: trimToString(spec.command), args: parseCommandArgs(spec.args), cwd: normalizeProjectPath(trimToString(spec.cwd || spec.workingDir || spec.working_directory || spec.projectPath)), projectId: trimToString(spec.projectId), projectPath: normalizeProjectPath(trimToString(spec.projectPath || spec.directory || spec.projectRoot)) };
  };
  async function spawnCliFromGatewayFrame(frame, runKey) {
    const spec = normalizeCommandSpecFrame(frame);
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
  const clearCliLaunchStateByRun = (runKey) => {
    const prefix = `${runKey}:`;
    for (const key of cliLaunchByRun.keys()) if (key.startsWith(prefix)) cliLaunchByRun.delete(key);
  };
  return { trimToString, parseCommandArgs, normalizeProjectPath, resolveProjectForCliSpec, captureExternalExecutionEvidence, spawnCliFromGatewayFrame, clearCliLaunchStateByRun, clearAllCliLaunchState: () => cliLaunchByRun.clear() };
}
