import { marked } from 'marked';
import { state } from './state.js';
import { gateway } from './gateway.js';

let updateOpenClawBadgeRef = () => {};
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
const MESSAGE_ENTER_DURATION_MS = 180;

function animateMessageEntry(element, enabled = true) {
  if (!enabled || !element) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  element.classList.add('message-enter');

  // Force a frame boundary so the browser can transition from the initial state.
  requestAnimationFrame(() => {
    element.classList.add('message-enter-active');
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    element.classList.remove('message-enter', 'message-enter-active');
    element.removeEventListener('transitionend', onTransitionEnd);
  };
  const onTransitionEnd = (event) => {
    if (event.target !== element) return;
    cleanup();
  };

  element.addEventListener('transitionend', onTransitionEnd);
  setTimeout(cleanup, MESSAGE_ENTER_DURATION_MS + 80);
}

export function configureChat({ updateOpenClawBadge }) {
  updateOpenClawBadgeRef = updateOpenClawBadge;
}
function resizeChatInput() {
  if (!chatInput) return;
  chatInput.style.height = 'auto';
  const nextHeight = Math.min(chatInput.scrollHeight, 120);
  chatInput.style.height = `${nextHeight}px`;
  chatInput.style.overflowY = chatInput.scrollHeight > 120 ? 'auto' : 'hidden';
}
function markBotUnread() {
  if (state.currentItem !== 'openclaw') {
    state.unreadCount += 1;
    updateOpenClawBadgeRef();
  }
}
function notifyIncomingBotMessage(text) {
  if (document.hasFocus()) return;
  const body = String(text || '')
    .replace(/```[\s\S]*?```|`[^`]*`|!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)|[#>*_~]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  if (!body) return;
  window.tgclaw.notifyChatMessage({ title: 'OpenClaw', body });
}
function renderBotMessage(div, text) {
  if (marked?.parse) div.innerHTML = marked.parse(text);
  else div.textContent = text;
}
function scrollChatToBottom() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.scrollTop = container.scrollHeight;
}
function showStopButton() {
  const btn = document.getElementById('chat-stop');
  if (btn) btn.style.display = 'inline-flex';
}
function hideStopButton() {
  const btn = document.getElementById('chat-stop');
  if (btn) btn.style.display = 'none';
}
function abortChat() {
  if (!isStreaming || !currentRunId) return;
  void gateway.chatAbort('default', currentRunId).catch(() => {});
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
  currentStreamDiv = null;
  currentStreamText = '';
  currentRunId = null;
  isStreaming = false;
  assistantPending = false;
  lastRenderTime = 0;
  hideStopButton();
  renderChatHeaderStatus();
}

async function loadChatHistory() {
  if (!gateway.connected) return;
  try {
    const messages = await gateway.chatHistory('default', 50);
    if (!Array.isArray(messages)) return;
    const container = document.getElementById('chat-messages');
    if (!container) return;
    container.innerHTML = '';
    messages.forEach((message) => {
      if (!message || typeof message.content !== 'string') return;
      if (message.role === 'user') {
        appendMessage(message.content, 'from-user', { animate: false });
        return;
      }
      if (message.role === 'assistant') appendMessage(message.content, 'from-bot', { animate: false });
    });
  } catch (error) {
    void error;
  }
}
export function appendMessage(text, cls, options = {}) {
  const animate = options.animate !== false;
  if (cls === 'from-bot') markBotUnread();
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `message ${cls}`;
  if (cls === 'from-bot') renderBotMessage(div, text);
  else div.textContent = text;
  container.appendChild(div);
  animateMessageEntry(div, animate);
  scrollChatToBottom();
  return div;
}
function createStreamMessage() {
  markBotUnread();
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message from-bot';
  container.appendChild(div);
  animateMessageEntry(div);
  scrollChatToBottom();
  return div;
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
  void gateway.chatSend('default', text).catch((err) => {
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
  gateway.on('connected', () => {
    gatewayOnline = true;
    renderChatHeaderStatus();
    void loadChatHistory();
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
  resizeChatInput();
}
