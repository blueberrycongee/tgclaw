import { appendMessage, scrollChatToBottom, updateEmptyState } from './chat-messages.js';
import { state } from './state.js';
import { gateway } from './gateway.js';
import { renderSessions, selectItem } from './sidebar.js';
import { ensureChatCacheLoaded, getCachedMessages, getCachedSessions, setCachedMessages } from './chat-cache.js';

const HISTORY_RECOVERY_POLL_MS = 3000;
const HISTORY_RECOVERY_STALE_MS = 90000;
let historyRecoveryTimer = null;
let historyRecoveryInFlight = false;
let pendingChatRequest = null;

const hooks = {
  normalizeSessionKeyForGateway: (sessionKey) => sessionKey || 'default',
  resetStreamingState: () => {},
  isAssistantPending: () => false,
  setAssistantPending: () => {},
  isStreaming: () => false,
  setAssistantStalled: () => {},
  clearTypingIndicator: () => {},
  syncStreamingUiState: () => {},
};

export function configureChatHistory(nextHooks = {}) { Object.assign(hooks, nextHooks); }
export function setPendingChatRequest(request) { pendingChatRequest = request; }
export function clearPendingChatRequest() { pendingChatRequest = null; }
export function getPendingChatRequest() { return pendingChatRequest; }

function countAssistantMessages(messages) { return messages.filter((message) => message?.role === 'assistant').length; }

function renderMergedMessages(messages) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '';
  renderHistoryMessages(messages);
  updateEmptyState();
  scrollChatToBottom();
}

async function attemptHistoryRecovery() {
  if (historyRecoveryInFlight || !hooks.isAssistantPending() || hooks.isStreaming() || !pendingChatRequest || !gateway.connected) return;
  const elapsed = Date.now() - pendingChatRequest.startedAt;
  if (elapsed > HISTORY_RECOVERY_STALE_MS) {
    hooks.setAssistantPending(false);
    hooks.setAssistantStalled(false);
    hooks.clearTypingIndicator();
    hooks.syncStreamingUiState();
    return;
  }
  historyRecoveryInFlight = true;
  try {
    await ensureChatCacheLoaded();
    const sessionKey = pendingChatRequest.sessionKey || 'default';
    const localMessages = getCachedMessages(sessionKey);
    const remotePayload = await gateway.chatHistory(hooks.normalizeSessionKeyForGateway(sessionKey), 50);
    const remoteMessages = Array.isArray(remotePayload) ? remotePayload : [];
    const mergedMessages = mergeHistoryMessages(localMessages, remoteMessages);
    const persisted = setCachedMessages(sessionKey, mergedMessages, { label: sessionLabelForKey(sessionKey), touchSession: sessionKey !== 'default' });
    const assistantCount = countAssistantMessages(persisted);
    if (state.currentSessionKey === sessionKey && persisted.length !== localMessages.length) renderMergedMessages(persisted);
    if (assistantCount > pendingChatRequest.assistantCountAtSend) {
      hooks.setAssistantPending(false);
      hooks.setAssistantStalled(false);
      hooks.clearTypingIndicator();
      hooks.syncStreamingUiState();
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
  historyRecoveryTimer = setInterval(() => { void attemptHistoryRecovery(); }, HISTORY_RECOVERY_POLL_MS);
}

function clearHistoryRecoveryTimer() {
  if (!historyRecoveryTimer) return;
  clearInterval(historyRecoveryTimer);
  historyRecoveryTimer = null;
}

function sessionLabelForKey(sessionKey) {
  if (!sessionKey || sessionKey === 'default') return 'OpenClaw';
  const session = (Array.isArray(state.sessions) ? state.sessions : []).find((item) => item?.sessionKey === sessionKey);
  return typeof session?.label === 'string' && session.label.trim() ? session.label.trim() : sessionKey;
}

function normalizeHistoryMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const content = typeof message.content === 'string' ? message.content : (typeof message.text === 'string' ? message.text : '');
  if (!content.trim()) return null;
  const role = message.role === 'assistant' || message.role === 'bot' ? 'assistant' : 'user';
  const timestamp = new Date(message.createdAt ?? message.ts ?? message.timestamp ?? Date.now()).getTime();
  const createdAt = Number.isFinite(timestamp) ? timestamp : Date.now();
  const id = typeof message.id === 'string' && message.id ? message.id : `${role}-${createdAt}-${Math.random().toString(16).slice(2, 8)}`;
  return { id, role, content, createdAt };
}

function mergeHistoryMessages(localMessages, remoteMessages) {
  const all = [...localMessages, ...remoteMessages].map(normalizeHistoryMessage).filter(Boolean).sort((left, right) => left.createdAt - right.createdAt);
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
    if (message.role === 'user') appendMessage(message.content, 'from-user', { animate: false, createdAt: message.createdAt });
    else appendMessage(message.content, 'from-bot', { animate: false, createdAt: message.createdAt });
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
  if (lastSessionKey && lastSessionKey !== 'default' && state.sessions.some((session) => session?.sessionKey === lastSessionKey)) {
    selectItem(`session:${lastSessionKey}`);
    return;
  }
  void reloadChatHistory();
}

async function reloadChatHistory() {
  await ensureChatCacheLoaded();
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const sessionKey = state.currentSessionKey || 'default';
  hooks.resetStreamingState();
  container.innerHTML = '';
  const localMessages = getCachedMessages(sessionKey);
  if (localMessages.length) renderHistoryMessages(localMessages);
  updateEmptyState();
  if (!gateway.connected) return;
  try {
    const remotePayload = await gateway.chatHistory(hooks.normalizeSessionKeyForGateway(sessionKey), 50);
    const remoteMessages = Array.isArray(remotePayload) ? remotePayload : [];
    const mergedMessages = mergeHistoryMessages(localMessages, remoteMessages);
    const persisted = setCachedMessages(sessionKey, mergedMessages, { label: sessionLabelForKey(sessionKey), touchSession: sessionKey !== 'default' });
    if (state.currentSessionKey !== sessionKey) return;
    container.innerHTML = '';
    renderHistoryMessages(persisted);
  } catch {
    // no-op
  }
  updateEmptyState();
}

export { countAssistantMessages, renderMergedMessages, attemptHistoryRecovery, startHistoryRecoveryLoop, clearHistoryRecoveryTimer, sessionLabelForKey, normalizeHistoryMessage, mergeHistoryMessages, renderHistoryMessages, hydrateChatFromCache, reloadChatHistory };
