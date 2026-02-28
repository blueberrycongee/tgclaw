import { renderBotMessage } from './markdown.js';
import { state } from './state.js';

const MESSAGE_ENTER_DURATION_MS = 180;
let updateOpenClawBadgeRef = () => {};

export function configureChatMessages({ updateOpenClawBadge }) {
  updateOpenClawBadgeRef = updateOpenClawBadge;
}

export function animateMessageEntry(element, enabled = true) {
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

export function scrollChatToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

export function updateEmptyState() {
  const container = document.getElementById('chat-messages');
  const emptyState = document.getElementById('chat-empty-state');
  if (!container || !emptyState) return;
  const hasMessages = Boolean(container.querySelector('.message'));
  emptyState.style.display = hasMessages ? 'none' : 'flex';
}

function activeChatItem() {
  return state.currentItem === 'openclaw' || state.currentItem.startsWith('session:');
}

export function markBotUnread() {
  if (activeChatItem()) return;
  state.unreadCount += 1;
  updateOpenClawBadgeRef();
}

export function notifyIncomingBotMessage(text) {
  if (document.hasFocus()) return;
  const body = String(text || '')
    .replace(/```[\s\S]*?```|`[^`]*`|!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)|[#>*_~]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  if (!body) return;
  window.tgclaw.notifyChatMessage({ title: 'OpenClaw', body });
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
  updateEmptyState();
  return div;
}

export function createStreamMessage() {
  markBotUnread();
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message from-bot';
  container.appendChild(div);
  animateMessageEntry(div);
  updateEmptyState();
  scrollChatToBottom();
  return div;
}
