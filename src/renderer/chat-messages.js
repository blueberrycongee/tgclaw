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
  const classList = String(cls || '').split(/\s+/).filter(Boolean);
  const isBotMessage = classList.includes('from-bot');
  if (isBotMessage) markBotUnread();
  const container = document.getElementById('chat-messages');
  const row = document.createElement('div');
  row.className = 'message-row';
  row.classList.add(classList.includes('from-user') ? 'from-user' : 'from-bot');
  const div = document.createElement('div');
  div.className = `message ${cls}`;
  if (isBotMessage) renderBotMessage(div, text);
  else div.textContent = text;
  const time = document.createElement('span');
  time.className = 'message-time';
  const createdAtTimestamp = new Date(options.createdAt).getTime();
  const createdAt = Number.isFinite(createdAtTimestamp) ? new Date(createdAtTimestamp) : new Date();
  time.dateTime = createdAt.toISOString();
  time.textContent = createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.appendChild(div);
  row.appendChild(time);
  if (isBotMessage) addCodeBlockCopyButtons(div);
  container.appendChild(row);
  animateMessageEntry(row, animate);
  scrollChatToBottom();
  updateEmptyState();
  return row;
}

function extractCodeLanguage(codeElement) {
  const classNames = String(codeElement?.className || '').split(/\s+/).filter(Boolean);
  const languageClass = classNames.find((name) => name.startsWith('language-'));
  if (!languageClass) return 'code';
  const language = languageClass.slice('language-'.length).trim().toLowerCase();
  return language || 'code';
}

export function addCodeBlockCopyButtons(container) {
  if (!container) return;
  container.querySelectorAll('pre > code').forEach((codeElement) => {
    const preElement = codeElement.parentElement;
    if (!preElement || preElement.parentElement?.classList.contains('code-block-wrapper')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const header = document.createElement('div');
    header.className = 'code-block-header';

    const language = document.createElement('span');
    language.textContent = extractCodeLanguage(codeElement);

    const copyButton = document.createElement('button');
    copyButton.className = 'code-copy-btn';
    copyButton.title = 'Copy code';
    copyButton.type = 'button';
    copyButton.textContent = '📋';
    copyButton.addEventListener('click', async () => {
      const text = codeElement.textContent || '';
      copyButton.disabled = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // no-op
      }
      copyButton.textContent = '✓';
      setTimeout(() => {
        copyButton.textContent = '📋';
        copyButton.disabled = false;
      }, 1500);
    });

    header.append(language, copyButton);
    preElement.replaceWith(wrapper);
    wrapper.append(header, preElement);
  });
}

export function createStreamMessage() {
  markBotUnread();
  const container = document.getElementById('chat-messages');
  const row = document.createElement('div');
  row.className = 'message-row from-bot';
  const div = document.createElement('div');
  div.className = 'message from-bot';
  const content = document.createElement('div');
  div.appendChild(content);
  const time = document.createElement('span');
  time.className = 'message-time';
  const createdAt = new Date();
  time.dateTime = createdAt.toISOString();
  time.textContent = createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.appendChild(div);
  row.appendChild(time);
  container.appendChild(row);
  animateMessageEntry(row);
  updateEmptyState();
  scrollChatToBottom();
  return content;
}
