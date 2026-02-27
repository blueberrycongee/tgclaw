import { marked } from 'marked';
import { state } from './state.js';

let updateOpenClawBadgeRef = () => {};
let chatInput = null;

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

export function appendMessage(text, cls) {
  if (cls === 'from-bot' && state.currentItem !== 'openclaw') {
    state.unreadCount += 1;
    updateOpenClawBadgeRef();
  }

  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `message ${cls}`;

  if (cls === 'from-bot' && marked?.parse) {
    div.innerHTML = marked.parse(text);
  } else {
    div.textContent = text;
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

export function sendChat() {
  const text = chatInput?.value.trim();
  if (!text) return;

  appendMessage(text, 'from-user');
  chatInput.value = '';
  resizeChatInput();

  setTimeout(() => {
    appendMessage("Got it. I'll dispatch that to the right agent. Check the project tabs for progress. 🐾", 'from-bot');
  }, 500);
}

export function initChat() {
  chatInput = document.getElementById('chat-input');
  chatInput.addEventListener('input', resizeChatInput);
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChat();
    }
  });
  resizeChatInput();
}
