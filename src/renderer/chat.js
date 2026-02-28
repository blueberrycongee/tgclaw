import { marked } from 'marked';
import { state } from './state.js';
import { gateway } from './gateway.js';

let updateOpenClawBadgeRef = () => {};
let chatInput = null;
let currentStreamDiv = null;
let currentStreamText = '';
let currentRunId = null;
let isStreaming = false;
let lastRenderTime = 0;
let chatHeaderStatus = null;
let chatHeaderStatusText = null;

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
function resetStreamingState() {
  currentStreamDiv = null;
  currentStreamText = '';
  currentRunId = null;
  isStreaming = false;
  lastRenderTime = 0;
  hideStopButton();
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
        appendMessage(message.content, 'from-user');
        return;
      }
      if (message.role === 'assistant') appendMessage(message.content, 'from-bot');
    });
  } catch (error) {
    void error;
  }
}
export function appendMessage(text, cls) {
  if (cls === 'from-bot') markBotUnread();
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `message ${cls}`;
  if (cls === 'from-bot') renderBotMessage(div, text);
  else div.textContent = text;
  container.appendChild(div);
  scrollChatToBottom();
  return div;
}
function createStreamMessage() {
  markBotUnread();
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message from-bot';
  container.appendChild(div);
  scrollChatToBottom();
  return div;
}
function extractFrameText(frame) {
  const fields = [frame?.delta, frame?.final, frame?.content, frame?.message, frame?.text];
  return fields.find((item) => typeof item === 'string') || '';
}
function handleGatewayChat(frame) {
  const eventState = typeof frame?.state === 'string' ? frame.state : '';
  if (eventState === 'delta') {
    const delta = extractFrameText(frame);
    if (!delta) return;
    if (typeof frame?.runId === 'string' && frame.runId) currentRunId = frame.runId;
    isStreaming = true;
    showStopButton();
    if (!currentStreamDiv) {
      currentStreamDiv = createStreamMessage();
      currentStreamText = '';
      lastRenderTime = 0;
    }
    currentStreamText += delta;
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
    resetStreamingState();
    return;
  }
  if (eventState === 'error') {
    const message = frame?.error?.message || extractFrameText(frame) || 'Unknown error';
    resetStreamingState();
    appendMessage(`Gateway error: ${message}`, 'from-bot');
  }
}
function updateConnectionStatus(online) {
  if (!chatHeaderStatus || !chatHeaderStatusText) return;
  chatHeaderStatus.classList.remove('is-online', 'is-offline', 'is-connecting');
  if (online) {
    chatHeaderStatus.classList.add('is-online');
    chatHeaderStatusText.textContent = 'Online';
    return;
  }
  chatHeaderStatus.classList.add('is-offline');
  chatHeaderStatusText.textContent = 'Offline';
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
  void gateway.chatSend('default', text).catch((err) => {
    appendMessage(`Gateway error: ${err?.message || 'Failed to send message'}`, 'from-bot');
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
    updateConnectionStatus(true);
    void loadChatHistory();
  });
  gateway.on('disconnected', () => updateConnectionStatus(false));
  gateway.on('error', () => updateConnectionStatus(false));

  updateConnectionStatus(gateway.connected);
  resizeChatInput();
}
