import { state } from './state.js';
import { scrollChatToBottom, updateEmptyState } from './chat-messages.js';
import { isChatItemId } from './utils.js';

const deps = {
  addAgentTab: () => {},
  closeTab: () => {},
  switchTab: () => {},
};

export function configureShortcuts(nextDeps) {
  Object.assign(deps, nextDeps);
}

export function newShellTabFromShortcut() {
  if (isChatItemId(state.currentItem)) return;
  deps.addAgentTab('shell');
}

export function closeActiveTabFromShortcut() {
  if (isChatItemId(state.currentItem)) return;
  const currentTabId = state.activeTab[state.currentItem];
  if (!currentTabId) return;
  deps.closeTab(state.currentItem, currentTabId);
}

export function switchTabByIndexFromShortcut(index) {
  if (isChatItemId(state.currentItem)) return;
  const projectTabs = state.tabs[state.currentItem] || [];
  const targetTab = projectTabs[index];
  if (!targetTab) return;
  deps.switchTab(state.currentItem, targetTab.id);
}

function clearChat() {
  const container = document.getElementById('chat-messages');
  if (container) container.innerHTML = '';
  updateEmptyState();
  scrollChatToBottom();
}

export function initShortcutBindings() {
  window.tgclaw.onAppShortcut(({ action, index }) => {
    if (action === 'new-shell-tab') {
      newShellTabFromShortcut();
      return;
    }

    if (action === 'close-current-tab') {
      closeActiveTabFromShortcut();
      return;
    }

    if (action === 'switch-tab' && Number.isInteger(index)) {
      switchTabByIndexFromShortcut(index);
      return;
    }

    if (action === 'clear-chat') {
      clearChat();
    }
  });
}
