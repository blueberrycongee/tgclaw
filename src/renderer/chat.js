import { renderBotMessage } from './markdown.js';
import { addCodeBlockCopyButtons, animateMessageEntry, appendMessage, configureChatMessages, createStreamMessage, notifyIncomingBotMessage, scrollChatToBottom, updateEmptyState } from './chat-messages.js';
import { state } from './state.js';
import { gateway } from './gateway.js';
import { renderSessions, selectItem } from './sidebar.js';
import { addAgentTab } from './tabs.js';
import { appendCachedMessage, ensureChatCacheLoaded, getCachedMessages, getCachedSessions, setCachedMessages } from './chat-cache.js';
const INITIAL_RESPONSE_TIMEOUT_MS = 12000;
const STREAM_IDLE_TIMEOUT_MS = 18000;
const HISTORY_RECOVERY_POLL_MS = 3000;
const HISTORY_RECOVERY_STALE_MS = 90000;
const DEFAULT_MAIN_SESSION_KEY = 'main';
let chatInput = null;
let currentRunId = null;
let currentRunKey = '';
let isStreaming = false;
let assistantPending = false;
let assistantStalled = false;
let gatewayOnline = false;
let gatewayMainSessionKey = DEFAULT_MAIN_SESSION_KEY;
let gatewayMainKey = DEFAULT_MAIN_SESSION_KEY;
let gatewayDefaultAgentId = '';
const streamRuns = new Map();
let chatHeaderStatus = null;
let chatHeaderStatusText = null;
let typingIndicatorDiv = null;
let pendingTimeoutHandle = null;
let streamIdleTimeoutHandle = null;
let historyRecoveryTimer = null;
let historyRecoveryInFlight = false;
let lastAssistantActivityAt = 0;
let pendingChatRequest = null;
const cliLaunchByRun = new Map();
const MAX_RECURSIVE_SPEC_DEPTH = 3;
const MAX_COMMAND_TEXT_LENGTH = 8192;
const COMMAND_SUGGESTION_KEYS = ['command', 'cmd', 'program', 'binary', 'executable'];

function trimToString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseCommandArgs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return item;
    if (item == null) return '';
    return String(item);
  }).filter(Boolean);
}

function parseCommandStringWithArgs(value) {
  if (typeof value !== 'string') return { command: '', args: [] };
  const text = value.trim();
  if (!text) return { command: '', args: [] };

  const rawParts = text.match(/(?:[^\s"]+|"([^"]*)"|'([^']*)')+/g);
  if (!rawParts) return { command: text, args: [] };

  const parts = rawParts.map((part) => {
    if (part.startsWith('"') && part.endsWith('"')) return part.slice(1, -1);
    if (part.startsWith('\'') && part.endsWith('\'')) return part.slice(1, -1);
    return part;
  }).filter(Boolean);

  if (parts.length === 0) return { command: '', args: [] };
  return { command: parts[0], args: parts.slice(1) };
}

function extractCommandSpecFromText(value) {
  const text = trimToString(value);
  if (!text || text.length > MAX_COMMAND_TEXT_LENGTH) return null;
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    const payload = JSON.parse(text);
    return parseCommandSpecFromValue(payload);
  } catch {
    return null;
  }
}

function parseCommandSpecFromValue(value, depth = 0) {
  if (!value || typeof value !== 'object') return null;
  if (depth > MAX_RECURSIVE_SPEC_DEPTH) return null;

  const command = COMMAND_SUGGESTION_KEYS
    .map((key) => trimToString(value[key]))
    .find(Boolean);
  if (command) {
    const inlineParts = parseCommandStringWithArgs(command);
    return {
      command: inlineParts.command || command,
      args: inlineParts.args.length > 0
        ? inlineParts.args
        : parseCommandArgs(value.args || value.argv || value.params || value.arguments),
      cwd: trimToString(value.cwd),
      projectId: trimToString(value.projectId),
      projectPath: trimToString(value.projectPath),
      workingDir: trimToString(value.workingDir),
    };
  }

  const candidate = trimToString(value.action) || trimToString(value.type) || trimToString(value.name);
  const action = trimToString(value.exec) || trimToString(value.tool) || trimToString(value.commandSource);
  const candidateLower = candidate.toLowerCase();
  if ((candidateLower === 'exec' || candidateLower === 'execute') && action) {
    const inlineParts = parseCommandStringWithArgs(action);
    return parseCommandSpecFromValue({
      command: inlineParts.command || action,
      args: inlineParts.args.length > 0
        ? inlineParts.args
        : value.args || value.argv || value.params || value.arguments,
      cwd: value.cwd,
      projectId: value.projectId,
      projectPath: value.projectPath,
      workingDir: value.workingDir,
    }, depth + 1);
  }

  const nested = value.meta || value.metadata || value.payload || value.data || value.details;
  if (nested && typeof nested === 'object') {
    const nestedSpec = parseCommandSpecFromValue(nested, depth + 1);
    if (nestedSpec) return nestedSpec;
  }

  const parsedTextSpec = extractCommandSpecFromText(trimToString(value.text) || trimToString(value.content));
  if (parsedTextSpec) return parsedTextSpec;

  const directJson = trimToString(value.commandJson);
  if (directJson) {
    const parsedFromText = extractCommandSpecFromText(directJson);
    if (parsedFromText) return parsedFromText;
  }

  return null;
}

function normalizeProjectPath(value) {
  const path = trimToString(value);
  if (!path) return '';
  return path.replace(/[/\\]+$/, '');
}

function parseCliLaunchSpec(frame) {
  const candidates = [
    frame,
    frame?.message,
    frame?.tool,
    frame?.toolCall,
    frame?.event,
    frame?.data,
    frame?.params,
    frame?.metadata,
    frame?.meta,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const spec = parseCommandSpecFromValue(candidate);
    if (spec) return spec;

    const textSpec = extractCommandSpecFromText(candidate?.text || candidate?.content);
    if (textSpec) return textSpec;
  }

  return null;
}

function normalizeCommandSpecSpecFrame(frame) {
  if (!frame) return null;
  const spec = parseCliLaunchSpec(frame);
  if (!spec || !spec.command) return null;
  return {
    command: trimToString(spec.command),
    args: parseCommandArgs(spec.args),
    cwd: normalizeProjectPath(trimToString(spec.cwd || spec.workingDir || spec.working_directory || spec.projectPath)),
    projectId: trimToString(spec.projectId),
    projectPath: normalizeProjectPath(trimToString(spec.projectPath || spec.directory || spec.projectRoot)),
  };
}

function resolveProjectForCliSpec(spec) {
  if (spec.projectId) {
    const byId = state.projects.find((project) => project.id === spec.projectId);
    if (byId) return byId;
  }

  const targetPaths = [normalizeProjectPath(spec.cwd), normalizeProjectPath(spec.projectPath)]
    .filter(Boolean);
  if (targetPaths.length > 0) {
    const direct = state.projects.find((project) => {
      const projectCwd = normalizeProjectPath(project.cwd);
      return targetPaths.includes(projectCwd) || targetPaths.some((path) => projectCwd.startsWith(path));
    });
    if (direct) return direct;
  }

  const currentProject = state.projects.find((project) => project.id === state.currentItem);
  if (currentProject) return currentProject;
  return state.projects[0];
}

async function spawnCliFromGatewayFrame(frame, runKey) {
  const spec = normalizeCommandSpecSpecFrame(frame);
  if (!spec) return;

  const dedupeKey = `${runKey}:${spec.command}:${(spec.args || []).join('\u001F')}`;
  if (cliLaunchByRun.has(dedupeKey)) return;
  cliLaunchByRun.set(dedupeKey, true);

  const project = resolveProjectForCliSpec(spec);
  if (!project) {
    if (state.currentItem === 'openclaw') {
      appendMessage('Failed to auto-launch CLI from chat: no project context found.', 'from-bot message-error');
    }
    return;
  }

  try {
    await addAgentTab(spec.command, {
      command: spec.command,
      commandArgs: spec.args,
      projectId: project.id,
    });
  } catch {
    // Keep stream behavior unchanged; terminal creation errors are surfaced in terminal UI.
  }
}

function clearCliLaunchStateByRun(runKey) {
  const prefix = `${runKey}:`;
  for (const key of cliLaunchByRun.keys()) {
    if (key.startsWith(prefix)) cliLaunchByRun.delete(key);
  }
}

function clearAllCliLaunchState() {
  cliLaunchByRun.clear();
}
export function configureChat({ updateOpenClawBadge }) { configureChatMessages({ updateOpenClawBadge }); }
function normalizeSessionKeyForGateway(sessionKey) {
  const key = typeof sessionKey === 'string' && sessionKey.trim() ? sessionKey.trim() : 'default';
  const mainSessionKey = gatewayMainSessionKey || DEFAULT_MAIN_SESSION_KEY;
  const mainKey = gatewayMainKey || DEFAULT_MAIN_SESSION_KEY;
  if (key === 'default' || key === DEFAULT_MAIN_SESSION_KEY || key === mainKey || key === mainSessionKey) {
    return mainSessionKey;
  }
  if (gatewayDefaultAgentId) {
    const aliases = [
      `agent:${gatewayDefaultAgentId}:main`,
      `agent:${gatewayDefaultAgentId}:${mainKey}`,
    ];
    if (aliases.includes(key)) return mainSessionKey;
  }
  return key;
}
function applyGatewaySessionDefaults(helloPayload) {
  const defaults = helloPayload?.snapshot?.sessionDefaults;
  const mainSessionKey = typeof defaults?.mainSessionKey === 'string' && defaults.mainSessionKey.trim()
    ? defaults.mainSessionKey.trim()
    : DEFAULT_MAIN_SESSION_KEY;
  gatewayMainSessionKey = mainSessionKey;
  gatewayMainKey = typeof defaults?.mainKey === 'string' && defaults.mainKey.trim()
    ? defaults.mainKey.trim()
    : DEFAULT_MAIN_SESSION_KEY;
  gatewayDefaultAgentId = typeof defaults?.defaultAgentId === 'string' ? defaults.defaultAgentId.trim() : '';
}
function normalizeAssistantMessage(message, options = {}) {
  if (!message || typeof message !== 'object') return null;
  const candidate = message;
  const requireRole = options.requireRole === true;
  const roleValue = typeof candidate.role === 'string' ? candidate.role.toLowerCase() : '';
  if (requireRole && roleValue !== 'assistant') return null;
  if (roleValue && roleValue !== 'assistant') return null;
  if (!('content' in candidate) && !('text' in candidate)) return null;
  return candidate;
}
function shouldReloadHistoryForFinalFrame(frame) {
  if (frame?.state !== 'final') return false;
  const message = frame?.message;
  if (!message || typeof message !== 'object') return true;
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  return Boolean(role && role !== 'assistant');
}
export function updateChatHeader() {
  const title = document.querySelector('.chat-header-title');
  if (!title) return;
  if (!state.currentSessionKey || state.currentSessionKey === 'default') {
    title.textContent = 'OpenClaw';
    return;
  }
  const session = (Array.isArray(state.sessions) ? state.sessions : []).find((item) => item && item.sessionKey === state.currentSessionKey);
  const label = typeof session?.label === 'string' && session.label.trim() ? session.label : state.currentSessionKey;
  title.textContent = label;
}
function resizeChatInput() {
  if (!chatInput) return;
  chatInput.style.height = 'auto';
  const nextHeight = Math.min(chatInput.scrollHeight, 120);
  chatInput.style.height = `${nextHeight}px`;
  chatInput.style.overflowY = chatInput.scrollHeight > 120 ? 'auto' : 'hidden';
}
function clearTypingIndicator() {
  if (!typingIndicatorDiv) return;
  typingIndicatorDiv.remove();
  typingIndicatorDiv = null;
  updateEmptyState();
}
function showTypingIndicator() {
  clearTypingIndicator();
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'message-row from-bot typing-row';
  const div = document.createElement('div');
  div.className = 'message from-bot typing-indicator';
  div.innerHTML = '<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>';
  row.appendChild(div);
  container.appendChild(row);
  typingIndicatorDiv = row;
  animateMessageEntry(row);
  updateEmptyState();
  scrollChatToBottom();
}
function clearPendingTimeout() {
  if (!pendingTimeoutHandle) return;
  clearTimeout(pendingTimeoutHandle);
  pendingTimeoutHandle = null;
}
function clearStreamIdleTimeout() {
  if (!streamIdleTimeoutHandle) return;
  clearTimeout(streamIdleTimeoutHandle);
  streamIdleTimeoutHandle = null;
}
function clearHistoryRecoveryTimer() {
  if (!historyRecoveryTimer) return;
  clearInterval(historyRecoveryTimer);
  historyRecoveryTimer = null;
}
function clearAssistantWatchdogs() {
  clearPendingTimeout();
  clearStreamIdleTimeout();
  clearHistoryRecoveryTimer();
}
function scheduleStreamIdleTimeout() {
  clearStreamIdleTimeout();
  if (!assistantPending && !isStreaming) return;
  streamIdleTimeoutHandle = setTimeout(() => {
    if (!assistantPending && !isStreaming) return;
    if (Date.now() - lastAssistantActivityAt < STREAM_IDLE_TIMEOUT_MS - 50) {
      scheduleStreamIdleTimeout();
      return;
    }
    assistantStalled = true;
    clearTypingIndicator();
    renderChatHeaderStatus();
  }, STREAM_IDLE_TIMEOUT_MS);
}
function touchAssistantActivity() {
  lastAssistantActivityAt = Date.now();
  if (assistantStalled) assistantStalled = false;
  clearPendingTimeout();
  scheduleStreamIdleTimeout();
}
function armInitialResponseTimeout() {
  clearPendingTimeout();
  pendingTimeoutHandle = setTimeout(() => {
    if (!assistantPending || isStreaming || streamRuns.size > 0) return;
    assistantStalled = true;
    clearTypingIndicator();
    renderChatHeaderStatus();
  }, INITIAL_RESPONSE_TIMEOUT_MS);
}
function beginAssistantPending() {
  const sessionKey = state.currentSessionKey || 'default';
  const assistantCountAtSend = getCachedMessages(sessionKey).filter((message) => message?.role === 'assistant').length;
  pendingChatRequest = {
    sessionKey,
    startedAt: Date.now(),
    assistantCountAtSend,
  };
  assistantPending = true;
  assistantStalled = false;
  showTypingIndicator();
  touchAssistantActivity();
  armInitialResponseTimeout();
  startHistoryRecoveryLoop();
}
function showStopButton() { const btn = document.getElementById('chat-stop'); if (btn) btn.style.display = 'inline-flex'; }
function hideStopButton() { const btn = document.getElementById('chat-stop'); if (btn) btn.style.display = 'none'; }
function abortChat() {
  if (!isStreaming || !currentRunId) return;
  void gateway.chatAbort(normalizeSessionKeyForGateway(state.currentSessionKey), currentRunId).catch(() => {});
}
function activeRunEntriesForSession(sessionKey) {
  const key = normalizeSessionKeyForGateway(sessionKey || 'default');
  return Array.from(streamRuns.entries()).filter(([, run]) => normalizeSessionKeyForGateway(run.sessionKey) === key);
}
function syncStreamingUiState() {
  const activeRuns = activeRunEntriesForSession(state.currentSessionKey);
  isStreaming = activeRuns.length > 0;
  if (isStreaming) showStopButton();
  else hideStopButton();

  if (currentRunKey && streamRuns.has(currentRunKey)) {
    currentRunId = streamRuns.get(currentRunKey).runId || currentRunId;
  } else if (activeRuns.length > 0) {
    const [latestRunKey, latestRun] = activeRuns[activeRuns.length - 1];
    currentRunKey = latestRunKey;
    currentRunId = latestRun.runId || currentRunId;
  } else {
    currentRunKey = '';
    currentRunId = null;
  }
  if (!assistantPending && !isStreaming) {
    assistantStalled = false;
    clearAssistantWatchdogs();
    pendingChatRequest = null;
  }
  renderChatHeaderStatus();
}
function renderChatHeaderStatus() {
  if (!chatHeaderStatus || !chatHeaderStatusText) return;

  chatHeaderStatus.classList.remove('is-online', 'is-offline', 'is-connecting', 'is-typing', 'is-waiting');
  if (!gatewayOnline) {
    chatHeaderStatus.classList.add('is-offline');
    chatHeaderStatusText.textContent = 'Offline';
    return;
  }

  if (assistantPending || isStreaming) {
    if (assistantStalled) {
      chatHeaderStatus.classList.add('is-waiting');
      chatHeaderStatusText.textContent = 'Waiting...';
      return;
    }
    chatHeaderStatus.classList.add('is-typing');
    chatHeaderStatusText.textContent = 'Typing...';
    return;
  }

  chatHeaderStatus.classList.add('is-online');
  chatHeaderStatusText.textContent = 'Online';
}
function resetStreamingState() {
  clearTypingIndicator();
  clearAssistantWatchdogs();
  clearAllCliLaunchState();
  streamRuns.forEach((run) => {
    if (run.contentDiv?.parentElement) run.contentDiv.parentElement.classList.remove('is-streaming');
  });
  streamRuns.clear();
  currentRunId = null;
  currentRunKey = '';
  isStreaming = false;
  assistantPending = false;
  assistantStalled = false;
  pendingChatRequest = null;
  historyRecoveryInFlight = false;
  hideStopButton();
  renderChatHeaderStatus();
}
function countAssistantMessages(messages) {
  return messages.filter((message) => message?.role === 'assistant').length;
}
function renderMergedMessages(messages) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '';
  renderHistoryMessages(messages);
  updateEmptyState();
  scrollChatToBottom();
}
async function attemptHistoryRecovery() {
  if (historyRecoveryInFlight) return;
  if (!assistantPending || isStreaming) return;
  if (!pendingChatRequest) return;
  if (!gateway.connected) return;

  const elapsed = Date.now() - pendingChatRequest.startedAt;
  if (elapsed > HISTORY_RECOVERY_STALE_MS) {
    assistantPending = false;
    assistantStalled = false;
    clearTypingIndicator();
    syncStreamingUiState();
    return;
  }

  historyRecoveryInFlight = true;
  try {
    await ensureChatCacheLoaded();
    const sessionKey = pendingChatRequest.sessionKey || 'default';
    const remoteSessionKey = normalizeSessionKeyForGateway(sessionKey);
    const localMessages = getCachedMessages(sessionKey);
    const remotePayload = await gateway.chatHistory(remoteSessionKey, 50);
    const remoteMessages = Array.isArray(remotePayload) ? remotePayload : [];
    const mergedMessages = mergeHistoryMessages(localMessages, remoteMessages);
    const persisted = setCachedMessages(sessionKey, mergedMessages, {
      label: sessionLabelForKey(sessionKey),
      touchSession: sessionKey !== 'default',
    });
    const assistantCount = countAssistantMessages(persisted);
    if (state.currentSessionKey === sessionKey && persisted.length !== localMessages.length) {
      renderMergedMessages(persisted);
    }
    if (assistantCount > pendingChatRequest.assistantCountAtSend) {
      assistantPending = false;
      assistantStalled = false;
      clearTypingIndicator();
      syncStreamingUiState();
    }
  } catch {
    // no-op
  } finally {
    historyRecoveryInFlight = false;
  }
}
function startHistoryRecoveryLoop() {
  clearHistoryRecoveryTimer();
  historyRecoveryInFlight = false;
  historyRecoveryTimer = setInterval(() => {
    void attemptHistoryRecovery();
  }, HISTORY_RECOVERY_POLL_MS);
}
function sessionLabelForKey(sessionKey) {
  if (!sessionKey || sessionKey === 'default') return 'OpenClaw';
  const session = (Array.isArray(state.sessions) ? state.sessions : []).find((item) => item?.sessionKey === sessionKey);
  return typeof session?.label === 'string' && session.label.trim() ? session.label.trim() : sessionKey;
}
function normalizeHistoryMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const content = typeof message.content === 'string'
    ? message.content
    : (typeof message.text === 'string' ? message.text : '');
  if (!content.trim()) return null;
  const role = message.role === 'assistant' || message.role === 'bot' ? 'assistant' : 'user';
  const timestamp = new Date(message.createdAt ?? message.ts ?? message.timestamp ?? Date.now()).getTime();
  const createdAt = Number.isFinite(timestamp) ? timestamp : Date.now();
  const id = typeof message.id === 'string' && message.id
    ? message.id
    : `${role}-${createdAt}-${Math.random().toString(16).slice(2, 8)}`;
  return { id, role, content, createdAt };
}
function mergeHistoryMessages(localMessages, remoteMessages) {
  const all = [...localMessages, ...remoteMessages]
    .map(normalizeHistoryMessage)
    .filter(Boolean)
    .sort((left, right) => left.createdAt - right.createdAt);

  const merged = [];
  const seenIds = new Set();
  all.forEach((message) => {
    if (seenIds.has(message.id)) return;
    seenIds.add(message.id);
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role && previous.content === message.content) return;
    merged.push(message);
  });
  return merged;
}
function renderHistoryMessages(messages) {
  messages.forEach((message) => {
    if (message.role === 'user') {
      appendMessage(message.content, 'from-user', { animate: false, createdAt: message.createdAt });
      return;
    }
    appendMessage(message.content, 'from-bot', { animate: false, createdAt: message.createdAt });
  });
}
async function hydrateChatFromCache() {
  await ensureChatCacheLoaded();
  const cachedSessions = getCachedSessions();
  if (!state.sessions.length && cachedSessions.length) {
    state.sessions = cachedSessions;
    renderSessions();
  }

  const lastSessionKey = localStorage.getItem('tgclaw:lastSessionKey');
  if (
    lastSessionKey
    && lastSessionKey !== 'default'
    && state.sessions.some((session) => session?.sessionKey === lastSessionKey)
  ) {
    selectItem(`session:${lastSessionKey}`);
    return;
  }

  void reloadChatHistory();
}
export async function reloadChatHistory() {
  await ensureChatCacheLoaded();
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const sessionKey = state.currentSessionKey || 'default';
  const remoteSessionKey = normalizeSessionKeyForGateway(sessionKey);
  resetStreamingState();
  container.innerHTML = '';

  const localMessages = getCachedMessages(sessionKey);
  if (localMessages.length) renderHistoryMessages(localMessages);
  updateEmptyState();

  if (!gateway.connected) return;

  try {
    const remotePayload = await gateway.chatHistory(remoteSessionKey, 50);
    const remoteMessages = Array.isArray(remotePayload) ? remotePayload : [];
    const mergedMessages = mergeHistoryMessages(localMessages, remoteMessages);
    const persisted = setCachedMessages(sessionKey, mergedMessages, {
      label: sessionLabelForKey(sessionKey),
      touchSession: sessionKey !== 'default',
    });
    if (state.currentSessionKey !== sessionKey) return;

    container.innerHTML = '';
    renderHistoryMessages(persisted);
  } catch {
    // no-op
  }
  updateEmptyState();
}
function extractMessageContent(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';

  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;

  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('');
  }

  return '';
}
function extractFrameText(frame) {
  const fields = [frame?.delta, frame?.final, frame?.content, frame?.text];
  const direct = fields.find((item) => typeof item === 'string');
  if (direct) return direct;
  return extractMessageContent(frame?.message);
}
function longestSuffixPrefixOverlap(left, right) {
  const maxLength = Math.min(left.length, right.length);
  for (let size = maxLength; size > 0; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) return size;
  }
  return 0;
}
function mergeIncomingText(currentText, incomingText) {
  if (!incomingText) return currentText;
  if (!currentText) return incomingText;
  if (incomingText === currentText) return currentText;

  // Snapshot mode: incoming already contains current rendered text.
  if (incomingText.startsWith(currentText)) return incomingText;

  // Late/out-of-order older frame, ignore to avoid rollback jitter.
  if (currentText.startsWith(incomingText)) return currentText;

  // Delta mode: append only the non-overlapping suffix.
  const overlap = longestSuffixPrefixOverlap(currentText, incomingText);
  if (overlap > 0) return currentText + incomingText.slice(overlap);

  // If model rewrites after a pause, prefer much longer snapshot to reduce abrupt flip on final.
  if (incomingText.length > currentText.length + 12) return incomingText;

  return `${currentText}${incomingText}`;
}

function resolveMessageRow(messageElement) {
  if (!messageElement) return null;
  const parent = messageElement.parentElement;
  if (parent?.classList.contains('message-row')) return parent;
  return messageElement;
}

function mergeStreamText(currentText, frame) {
  let merged = currentText;
  const directDelta = typeof frame?.delta === 'string' ? frame.delta : '';
  if (directDelta) merged = mergeIncomingText(merged, directDelta);

  const snapshots = [
    extractMessageContent(frame?.message),
    typeof frame?.content === 'string' ? frame.content : '',
    typeof frame?.text === 'string' ? frame.text : '',
  ].filter(Boolean);
  snapshots.forEach((snapshot) => {
    merged = mergeIncomingText(merged, snapshot);
  });

  return merged;
}
function extractFrameRunId(frame) {
  if (typeof frame?.runId === 'string' && frame.runId.trim()) return frame.runId.trim();
  if (typeof frame?.run?.id === 'string' && frame.run.id.trim()) return frame.run.id.trim();
  return '';
}
function extractFrameSessionKey(frame) {
  const keys = [
    frame?.sessionKey,
    frame?.session?.sessionKey,
    frame?.session?.key,
    frame?.session,
  ];
  const sessionKey = keys.find((item) => typeof item === 'string' && item.trim());
  const rawSessionKey = typeof sessionKey === 'string' ? sessionKey.trim() : (state.currentSessionKey || 'default');
  return normalizeSessionKeyForGateway(rawSessionKey);
}
function streamRunKey(frame) {
  const sessionKey = extractFrameSessionKey(frame);
  const runId = extractFrameRunId(frame);
  if (runId) return { key: `${sessionKey}:${runId}`, sessionKey, runId };
  return { key: `${sessionKey}:anonymous`, sessionKey, runId: '' };
}
function queueStreamRender(run) {
  if (!run?.contentDiv || run.renderQueued) return;
  run.renderQueued = true;
  requestAnimationFrame(() => {
    run.renderQueued = false;
    if (!run.contentDiv) return;
    run.contentDiv.textContent = run.text;
    scrollChatToBottom();
  });
}
function formatGatewayErrorMessage(rawMessage) {
  const message = typeof rawMessage === 'string' && rawMessage.trim()
    ? rawMessage.trim()
    : 'Unknown error';
  const normalized = message.toLowerCase();

  const looksLikeRelayHeaderMismatch = normalized.includes('temporarily overloaded')
    || normalized.includes('upstream service unavailable');
  if (!looksLikeRelayHeaderMismatch) return message;

  return `${message} Hint: if Claude Code works with the same relay, check OpenClaw provider headers/auth mode (Bearer auth + Claude CLI headers).`;
}
function handleGatewayChat(frame) {
  const eventState = typeof frame?.state === 'string' ? frame.state : '';
  const { key: runKey, sessionKey: frameSessionKey, runId: frameRunId } = streamRunKey(frame);
  const currentSessionKey = normalizeSessionKeyForGateway(state.currentSessionKey || 'default');
  const isCurrentSessionFrame = frameSessionKey === currentSessionKey;
  const runLookupKey = `${frameSessionKey}:${frameRunId || 'anonymous'}`;
  if (eventState === 'final') {
    void spawnCliFromGatewayFrame(frame, runLookupKey);
  }

  if (isCurrentSessionFrame) {
    touchAssistantActivity();
    if (assistantPending) assistantPending = false;
  }

  if (eventState === 'delta') {
    const delta = extractFrameText(frame);
    if (!delta) return;

    let run = streamRuns.get(runKey);
    if (!run) {
      if (!isCurrentSessionFrame) return;
      clearTypingIndicator();
      const contentDiv = createStreamMessage();
      if (contentDiv?.parentElement) contentDiv.parentElement.classList.add('is-streaming');
      run = {
        key: runKey,
        runId: frameRunId,
        sessionKey: frameSessionKey,
        text: '',
        startedAt: Date.now(),
        contentDiv,
        renderQueued: false,
      };
      streamRuns.set(runKey, run);
    } else if (frameRunId && !run.runId) {
      run.runId = frameRunId;
    }

    if (isCurrentSessionFrame) {
      run.text = mergeStreamText(run.text, frame);
      queueStreamRender(run);
      currentRunKey = runKey;
      if (run.runId) currentRunId = run.runId;
      syncStreamingUiState();
    }
    return;
  }

  if (eventState === 'final') {
    const run = streamRuns.get(runKey);
    const finalMessage = normalizeAssistantMessage(frame?.message, { requireRole: false });
    const finalText = extractFrameText(frame) || extractMessageContent(finalMessage) || run?.text || '';
    if (run?.contentDiv && isCurrentSessionFrame) {
      const runMessage = run.contentDiv.parentElement;
      const runRow = resolveMessageRow(runMessage);
      if (runMessage) runMessage.classList.remove('is-streaming');
      if (finalText) {
        renderBotMessage(run.contentDiv, finalText);
        addCodeBlockCopyButtons(run.contentDiv);
        scrollChatToBottom();
      } else if (runRow) {
        runRow.remove();
      }
    } else if (finalText && isCurrentSessionFrame) {
      appendMessage(finalText, 'from-bot', { createdAt: Date.now() });
    }

    if (finalText) {
      const cacheSessionKey = isCurrentSessionFrame ? (state.currentSessionKey || 'default') : frameSessionKey;
      appendCachedMessage(cacheSessionKey, {
        role: 'assistant',
        content: finalText,
        createdAt: run?.startedAt || Date.now(),
      }, {
        label: sessionLabelForKey(cacheSessionKey),
        touchSession: cacheSessionKey !== 'default',
      });
    }
    if (finalText && isCurrentSessionFrame) notifyIncomingBotMessage(finalText);
    if (!finalText && isCurrentSessionFrame && shouldReloadHistoryForFinalFrame(frame)) {
      void reloadChatHistory();
    }
    if (run) {
      if (run.contentDiv?.parentElement) run.contentDiv.parentElement.classList.remove('is-streaming');
      streamRuns.delete(runKey);
    }
    clearCliLaunchStateByRun(runLookupKey);
    if (currentRunKey === runKey) currentRunKey = '';
    syncStreamingUiState();
    return;
  }
  if (eventState === 'aborted') {
    const run = streamRuns.get(runKey);
    const normalizedMessage = normalizeAssistantMessage(frame?.message, { requireRole: true });
    const abortedText = extractMessageContent(normalizedMessage) || extractFrameText(frame) || run?.text || '';
    if (run?.contentDiv && isCurrentSessionFrame) {
      const runMessage = run.contentDiv.parentElement;
      const runRow = resolveMessageRow(runMessage);
      if (runMessage) runMessage.classList.remove('is-streaming');
      if (abortedText) {
        renderBotMessage(run.contentDiv, abortedText);
        addCodeBlockCopyButtons(run.contentDiv);
        scrollChatToBottom();
      } else if (runRow) {
        runRow.remove();
      }
    } else if (abortedText && isCurrentSessionFrame) {
      appendMessage(abortedText, 'from-bot', { createdAt: Date.now() });
    }
    if (abortedText) {
      const cacheSessionKey = isCurrentSessionFrame ? (state.currentSessionKey || 'default') : frameSessionKey;
      appendCachedMessage(cacheSessionKey, {
        role: 'assistant',
        content: abortedText,
        createdAt: run?.startedAt || Date.now(),
      }, {
        label: sessionLabelForKey(cacheSessionKey),
        touchSession: cacheSessionKey !== 'default',
      });
    }
    if (run?.contentDiv?.parentElement) run.contentDiv.parentElement.classList.remove('is-streaming');
    streamRuns.delete(runKey);
    clearCliLaunchStateByRun(runLookupKey);
    if (currentRunKey === runKey) currentRunKey = '';
    syncStreamingUiState();
    return;
  }
  if (eventState === 'error') {
    const rawMessage = frame?.error?.message || frame?.errorMessage || extractFrameText(frame);
    const message = formatGatewayErrorMessage(rawMessage);
    const run = streamRuns.get(runKey);
    if (run?.contentDiv?.parentElement) run.contentDiv.parentElement.classList.remove('is-streaming');
    streamRuns.delete(runKey);
    clearCliLaunchStateByRun(runLookupKey);
    if (currentRunKey === runKey) currentRunKey = '';
    if (isCurrentSessionFrame) appendMessage(`Gateway error: ${message}`, 'from-bot message-error');
    syncStreamingUiState();
  }
}
export function sendChat() {
  const text = chatInput?.value.trim();
  if (!text) return;
  const createdAt = Date.now();
  appendMessage(text, 'from-user', { createdAt });
  appendCachedMessage(state.currentSessionKey, {
    role: 'user',
    content: text,
    createdAt,
  }, {
    label: sessionLabelForKey(state.currentSessionKey),
    touchSession: state.currentSessionKey !== 'default',
  });
  chatInput.value = '';
  resizeChatInput();
  if (!gateway.connected) {
    appendMessage('Not connected to OpenClaw. Open Gateway Settings to configure.', 'from-bot');
    return;
  }
  beginAssistantPending();
  renderChatHeaderStatus();
  void gateway.chatSend(normalizeSessionKeyForGateway(state.currentSessionKey), text).catch((err) => {
    resetStreamingState();
    appendMessage(`Gateway error: ${formatGatewayErrorMessage(err?.message || 'Failed to send message')}`, 'from-bot message-error');
  });
}
export function initChat() {
  chatInput = document.getElementById('chat-input');
  chatHeaderStatus = document.querySelector('.chat-header-status');
  chatHeaderStatusText = document.getElementById('chat-status-text');
  document.getElementById('chat-send')?.addEventListener('click', sendChat);
  document.getElementById('chat-stop')?.addEventListener('click', abortChat);
  chatInput.addEventListener('input', resizeChatInput);
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChat();
    }
  });
  gateway.on('chat', handleGatewayChat);
  gateway.on('connected', (helloPayload) => {
    applyGatewaySessionDefaults(helloPayload);
    gatewayOnline = true;
    renderChatHeaderStatus();
    void reloadChatHistory();
  });
  gateway.on('disconnected', () => {
    gatewayOnline = false;
    resetStreamingState();
  });
  gateway.on('error', () => {
    gatewayOnline = false;
    resetStreamingState();
  });

  gatewayOnline = gateway.connected;
  renderChatHeaderStatus();
  updateChatHeader();
  updateEmptyState();
  resizeChatInput();
  void hydrateChatFromCache();
}
