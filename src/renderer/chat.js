import { renderBotMessage } from './markdown.js';
import { addCodeBlockCopyButtons, animateMessageEntry, appendMessage, configureChatMessages, createStreamMessage, notifyIncomingBotMessage, scrollChatToBottom, updateEmptyState } from './chat-messages.js';
import { state } from './state.js';
import { gateway } from './gateway.js';
import { renderSessions, selectItem } from './sidebar.js';
import { appendCachedMessage, ensureChatCacheLoaded, getCachedMessages, getCachedSessions, setCachedMessages } from './chat-cache.js';
let chatInput = null;
let currentStreamDiv = null;
let currentStreamText = '';
let currentRunId = null;
let currentStreamStartedAt = 0;
let isStreaming = false;
let assistantPending = false;
let gatewayOnline = false;
let streamRenderQueued = false;
let chatHeaderStatus = null;
let chatHeaderStatusText = null;
let typingIndicatorDiv = null;
export function configureChat({ updateOpenClawBadge }) { configureChatMessages({ updateOpenClawBadge }); }
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
  const div = document.createElement('div');
  div.className = 'message from-bot typing-indicator';
  div.innerHTML = '<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>';
  container.appendChild(div);
  typingIndicatorDiv = div;
  animateMessageEntry(div);
  updateEmptyState();
  scrollChatToBottom();
}
function showStopButton() { const btn = document.getElementById('chat-stop'); if (btn) btn.style.display = 'inline-flex'; }
function hideStopButton() { const btn = document.getElementById('chat-stop'); if (btn) btn.style.display = 'none'; }
function abortChat() {
  if (!isStreaming || !currentRunId) return;
  void gateway.chatAbort(state.currentSessionKey, currentRunId).catch(() => {});
}
function renderChatHeaderStatus() {
  if (!chatHeaderStatus || !chatHeaderStatusText) return;

  chatHeaderStatus.classList.remove('is-online', 'is-offline', 'is-connecting', 'is-typing');
  if (!gatewayOnline) {
    chatHeaderStatus.classList.add('is-offline');
    chatHeaderStatusText.textContent = 'Offline';
    return;
  }

  if (assistantPending || isStreaming) {
    chatHeaderStatus.classList.add('is-typing');
    chatHeaderStatusText.textContent = 'Typing...';
    return;
  }

  chatHeaderStatus.classList.add('is-online');
  chatHeaderStatusText.textContent = 'Online';
}
function resetStreamingState() {
  clearTypingIndicator();
  if (currentStreamDiv?.parentElement) currentStreamDiv.parentElement.classList.remove('is-streaming');
  currentStreamDiv = null;
  currentStreamText = '';
  currentRunId = null;
  currentStreamStartedAt = 0;
  isStreaming = false;
  assistantPending = false;
  streamRenderQueued = false;
  hideStopButton();
  renderChatHeaderStatus();
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
  resetStreamingState();
  container.innerHTML = '';

  const localMessages = getCachedMessages(sessionKey);
  if (localMessages.length) renderHistoryMessages(localMessages);
  updateEmptyState();

  if (!gateway.connected) return;

  try {
    const remotePayload = await gateway.chatHistory(sessionKey, 50);
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
function queueStreamRender() {
  if (!currentStreamDiv || streamRenderQueued) return;
  streamRenderQueued = true;
  requestAnimationFrame(() => {
    streamRenderQueued = false;
    if (!currentStreamDiv) return;
    currentStreamDiv.textContent = currentStreamText;
    scrollChatToBottom();
  });
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
  clearTypingIndicator();
  const eventState = typeof frame?.state === 'string' ? frame.state : '';
  if (eventState === 'delta') {
    const delta = extractFrameText(frame);
    if (!delta) return;
    if (typeof frame?.runId === 'string' && frame.runId) currentRunId = frame.runId;
    assistantPending = false;
    isStreaming = true;
    showStopButton();
    renderChatHeaderStatus();
    if (!currentStreamDiv) {
      currentStreamDiv = createStreamMessage();
      if (currentStreamDiv?.parentElement) currentStreamDiv.parentElement.classList.add('is-streaming');
      currentStreamText = '';
      currentStreamStartedAt = Date.now();
    }
    currentStreamText = mergeStreamText(currentStreamText, frame);
    queueStreamRender();
    return;
  }
  if (eventState === 'final') {
    const finalText = extractFrameText(frame) || currentStreamText;
    if (currentStreamDiv) {
      if (currentStreamDiv.parentElement) currentStreamDiv.parentElement.classList.remove('is-streaming');
      renderBotMessage(currentStreamDiv, finalText);
      addCodeBlockCopyButtons(currentStreamDiv);
      scrollChatToBottom();
    } else if (finalText) {
      appendMessage(finalText, 'from-bot');
    }
    if (finalText) {
      appendCachedMessage(state.currentSessionKey, {
        role: 'assistant',
        content: finalText,
        createdAt: currentStreamStartedAt || Date.now(),
      }, {
        label: sessionLabelForKey(state.currentSessionKey),
        touchSession: state.currentSessionKey !== 'default',
      });
    }
    if (finalText) notifyIncomingBotMessage(finalText);
    resetStreamingState();
    return;
  }
  if (eventState === 'error') {
    const rawMessage = frame?.error?.message || frame?.errorMessage || extractFrameText(frame);
    const message = formatGatewayErrorMessage(rawMessage);
    resetStreamingState();
    appendMessage(`Gateway error: ${message}`, 'from-bot message-error');
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
  assistantPending = true;
  renderChatHeaderStatus();
  showTypingIndicator();
  void gateway.chatSend(state.currentSessionKey, text).catch((err) => {
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
  gateway.on('connected', () => {
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
