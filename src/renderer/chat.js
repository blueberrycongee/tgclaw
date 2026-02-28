import { renderBotMessage } from './markdown.js';
import { animateMessageEntry, appendMessage, configureChatMessages, createStreamMessage, notifyIncomingBotMessage, scrollChatToBottom, updateEmptyState } from './chat-messages.js';
import { state } from './state.js';
import { gateway } from './gateway.js';
import { renderSessions } from './sidebar.js';
let chatInput = null;
let currentStreamDiv = null;
let currentStreamText = '';
let currentRunId = null;
let isStreaming = false;
let assistantPending = false;
let gatewayOnline = false;
let lastRenderTime = 0;
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
  currentStreamDiv = null;
  currentStreamText = '';
  currentRunId = null;
  isStreaming = false;
  assistantPending = false;
  lastRenderTime = 0;
  hideStopButton();
  renderChatHeaderStatus();
}
export async function reloadChatHistory() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  resetStreamingState();
  container.innerHTML = '';
  if (!gateway.connected) {
    updateEmptyState();
    return;
  }
  try {
    const messages = await gateway.chatHistory(state.currentSessionKey, 50);
    if (!Array.isArray(messages)) {
      updateEmptyState();
      return;
    }
    messages.forEach((message) => {
      if (!message || typeof message.content !== 'string') return;
      if (message.role === 'user') {
        appendMessage(message.content, 'from-user', { animate: false });
        return;
      }
      if (message.role === 'assistant') appendMessage(message.content, 'from-bot', { animate: false });
    });
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
function mergeStreamText(currentText, frame) {
  const directDelta = typeof frame?.delta === 'string' ? frame.delta : '';
  if (directDelta) return currentText + directDelta;

  const snapshot = extractMessageContent(frame?.message);
  if (!snapshot) return currentText;
  if (!currentText || snapshot === currentText) return snapshot;

  if (snapshot.startsWith(currentText)) return snapshot;
  if (currentText.startsWith(snapshot)) return currentText;

  const overlap = longestSuffixPrefixOverlap(currentText, snapshot);
  if (overlap > 0) return currentText + snapshot.slice(overlap);

  return snapshot;
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
      currentStreamText = '';
      lastRenderTime = 0;
    }
    currentStreamText = mergeStreamText(currentStreamText, frame);
    if (Date.now() - lastRenderTime > 300) {
      renderBotMessage(currentStreamDiv, currentStreamText);
      lastRenderTime = Date.now();
    } else {
      currentStreamDiv.textContent = currentStreamText;
    }
    scrollChatToBottom();
    return;
  }
  if (eventState === 'final') {
    const finalText = extractFrameText(frame) || currentStreamText;
    if (currentStreamDiv) {
      renderBotMessage(currentStreamDiv, finalText);
      scrollChatToBottom();
    } else if (finalText) {
      appendMessage(finalText, 'from-bot');
    }
    if (finalText) notifyIncomingBotMessage(finalText);
    resetStreamingState();
    return;
  }
  if (eventState === 'error') {
    const rawMessage = frame?.error?.message || frame?.errorMessage || extractFrameText(frame);
    const message = formatGatewayErrorMessage(rawMessage);
    resetStreamingState();
    appendMessage(`Gateway error: ${message}`, 'from-bot');
  }
}
export function sendChat() {
  const text = chatInput?.value.trim();
  if (!text) return;
  appendMessage(text, 'from-user');
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
    appendMessage(`Gateway error: ${formatGatewayErrorMessage(err?.message || 'Failed to send message')}`, 'from-bot');
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
  gateway.on('connected', async () => {
    gatewayOnline = true;
    renderChatHeaderStatus();
    void reloadChatHistory();
    try {
      const result = await gateway.sessionsList();
      state.sessions = Array.isArray(result?.sessions) ? result.sessions : (Array.isArray(result) ? result : []);
      renderSessions();
      updateChatHeader();
    } catch {
      // no-op
    }
  });
  gateway.on('disconnected', () => {
    gatewayOnline = false;
    resetStreamingState();
    state.sessions = [];
    renderSessions();
    updateChatHeader();
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
}
