import { marked } from 'marked';
import { state } from './state.js';
import { gateway } from './gateway.js';

let updateOpenClawBadgeRef = () => {};
let chatInput = null;
let currentStreamDiv = null;
let currentStreamText = '';
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
    if (!currentStreamDiv) {
      currentStreamDiv = createStreamMessage();
      currentStreamText = '';
    }
    currentStreamText += delta;
    currentStreamDiv.textContent = currentStreamText;
    scrollChatToBottom();
    return;
  }

  if (eventState === 'final') {
    const finalText = extractFrameText(frame) || currentStreamText;
    if (currentStreamDiv) {
      renderBotMessage(currentStreamDiv, finalText);
      currentStreamDiv = null;
      currentStreamText = '';
      scrollChatToBottom();
      return;
    }
    if (finalText) appendMessage(finalText, 'from-bot');
    return;
  }

  if (eventState === 'error') {
    const message = frame?.error?.message || extractFrameText(frame) || 'Unknown error';
    currentStreamDiv = null;
    currentStreamText = '';
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
    appendMessage('Not connected to OpenClaw. Click ⚙️ to configure.', 'from-bot');
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
  chatInput.addEventListener('input', resizeChatInput);
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChat();
    }
  });

  gateway.on('chat', handleGatewayChat);
  gateway.on('connected', () => updateConnectionStatus(true));
  gateway.on('disconnected', () => updateConnectionStatus(false));
  gateway.on('error', () => updateConnectionStatus(false));

  updateConnectionStatus(gateway.connected);
  resizeChatInput();
}
