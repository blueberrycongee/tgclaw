import { renderBotMessage } from './markdown.js';
import { addCodeBlockCopyButtons, animateMessageEntry, appendMessage, configureChatMessages, createStreamMessage, notifyIncomingBotMessage, scrollChatToBottom, updateEmptyState } from './chat-messages.js';
import { state } from './state.js';
import { gateway } from './gateway.js';
import { renderSessions, selectItem } from './sidebar.js';
import { addAgentTab } from './tabs.js';
import { appendCachedMessage, ensureChatCacheLoaded, getCachedMessages, getCachedSessions, setCachedMessages } from './chat-cache.js';
import { isChatItemId } from './utils.js';
import { createChatCliSpawn } from './chat-cli-spawn.js';
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
const ENABLE_CHAT_TEXT_COMMAND_FALLBACK = false;
const MAX_HANDLED_TERMINAL_REQUESTS = 400;
const handledTerminalRequestKeys = [];
const handledTerminalRequestSet = new Set();
const cliSpawn = createChatCliSpawn({
  state,
  addAgentTab,
  appendMessage,
  isChatItemId,
  selectItem,
  extractMessageContent,
});
const {
  trimToString,
  parseCommandArgs,
  normalizeProjectPath,
  resolveProjectForCliSpec,
  captureExternalExecutionEvidence,
  spawnCliFromGatewayFrame,
  clearCliLaunchStateByRun,
  clearAllCliLaunchState,
} = cliSpawn;

function trimHandledTerminalRequestKeys() {
  while (handledTerminalRequestKeys.length > MAX_HANDLED_TERMINAL_REQUESTS) {
    const removed = handledTerminalRequestKeys.shift();
    if (!removed) continue;
    handledTerminalRequestSet.delete(removed);
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
    requestId: trimToString(payload.requestId),
    runId: trimToString(payload.runId),
    projectId: trimToString(payload.projectId),
    cwd: normalizeProjectPath(trimToString(payload.cwd)),
    command: trimToString(payload.command),
    args,
    titleHint: trimToString(payload.titleHint),
    env: payload.env && typeof payload.env === 'object' ? payload.env : {},
    cols: Number.isFinite(cols) ? cols : undefined,
    rows: Number.isFinite(rows) ? rows : undefined,
    autoAttach: payload.autoAttach !== false,
    initialInput: typeof payload.initialInput === 'string' ? payload.initialInput : '',
    terminalSessionId: trimToString(payload.terminalSessionId),
  };
}

async function notifyGatewayTerminalRequestStarted(request, terminalSession) {
  const terminalSessionId = trimToString(terminalSession?.terminalSessionId);
  if (!terminalSessionId || !gateway.connected) return;
  try {
    await gateway.send('terminal.request.started', {
      requestId: request.requestId || undefined,
      runId: request.runId || undefined,
      terminalSessionId,
      pid: Number.isInteger(terminalSession?.pid) ? terminalSession.pid : undefined,
      projectId: request.projectId || undefined,
    });
  } catch {
    // no-op
  }
}

async function notifyGatewayTerminalRequestFailed(request, reason, message) {
  if (!gateway.connected) return;
  try {
    await gateway.send('terminal.request.failed', {
      requestId: request.requestId || undefined,
      runId: request.runId || undefined,
      reason: trimToString(reason) || 'start_failed',
      message: trimToString(message) || 'Terminal start failed',
    });
  } catch {
    // no-op
  }
}

function resolveProjectForTerminalRequest(request) {
  return resolveProjectForCliSpec({
    projectId: request.projectId,
    cwd: request.cwd,
    projectPath: request.cwd,
  });
}

async function startTerminalFromGatewayRequest(request) {
  const key = terminalRequestKey(request);
  if (handledTerminalRequestSet.has(key)) return;

  const project = resolveProjectForTerminalRequest(request);
  if (!project) {
    rememberHandledTerminalRequest(key);
    if (isChatItemId(state.currentItem)) {
      appendMessage('Failed to start terminal from gateway request: no project found.', 'from-bot message-error');
    }
    await notifyGatewayTerminalRequestFailed(request, 'project_not_found', 'No matching project for terminal request');
    return;
  }

  try {
    const tab = await addAgentTab(request.command || 'shell', {
      projectId: project.id,
      command: request.command,
      commandArgs: request.args,
      terminalSessionId: request.terminalSessionId,
      terminalRequest: {
        ...request,
        projectId: request.projectId || project.id,
        cwd: request.cwd || project.cwd,
      },
    });
    rememberHandledTerminalRequest(key);
    if (request.autoAttach) {
      selectItem(project.id);
    }
    await notifyGatewayTerminalRequestStarted(request, tab);
  } catch (error) {
    rememberHandledTerminalRequest(key);
    const message = error instanceof Error ? error.message : 'Terminal start failed';
    if (isChatItemId(state.currentItem)) {
      appendMessage(`Failed to start terminal: ${message}`, 'from-bot message-error');
    }
    await notifyGatewayTerminalRequestFailed(request, 'start_failed', message);
  }
}

function handleGatewayEventFrame(frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.event === 'terminal.request.start') {
    const request = normalizeTerminalStartPayload(frame.payload);
    if (!request) return;
    void startTerminalFromGatewayRequest(request);
    return;
  }
  if (frame.event === 'terminal.request.started') {
    const request = normalizeTerminalStartPayload(frame.payload);
    if (!request || !request.terminalSessionId) return;
    void startTerminalFromGatewayRequest(request);
    return;
  }
  if (frame.event === 'terminal.request.failed') {
    const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {};
    const message = trimToString(payload.message) || 'Terminal request failed.';
    if (isChatItemId(state.currentItem)) {
      appendMessage(message, 'from-bot message-error');
    }
  }
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
  captureExternalExecutionEvidence(frame);

  const eventState = typeof frame?.state === 'string' ? frame.state : '';
  const { key: runKey, sessionKey: frameSessionKey, runId: frameRunId } = streamRunKey(frame);
  const currentSessionKey = normalizeSessionKeyForGateway(state.currentSessionKey || 'default');
  const isCurrentSessionFrame = frameSessionKey === currentSessionKey;
  const runLookupKey = `${frameSessionKey}:${frameRunId || 'anonymous'}`;
  if (ENABLE_CHAT_TEXT_COMMAND_FALLBACK && eventState === 'final') {
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
  gateway.on('event', handleGatewayEventFrame);
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
