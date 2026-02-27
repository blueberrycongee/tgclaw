import { state } from './state.js';

const deps = {
  addAgentTab: () => {},
  closeTab: () => {},
  switchTab: () => {},
};

export function configureShortcuts(nextDeps) {
  Object.assign(deps, nextDeps);
}

export function newShellTabFromShortcut() {
  if (state.currentItem === 'openclaw') return;
  deps.addAgentTab('shell');
}

export function closeActiveTabFromShortcut() {
  if (state.currentItem === 'openclaw') return;
  const currentTabId = state.activeTab[state.currentItem];
  if (!currentTabId) return;
  deps.closeTab(state.currentItem, currentTabId);
}

export function switchTabByIndexFromShortcut(index) {
  if (state.currentItem === 'openclaw') return;
  const projectTabs = state.tabs[state.currentItem] || [];
  const targetTab = projectTabs[index];
  if (!targetTab) return;
  deps.switchTab(state.currentItem, targetTab.id);
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
    }
  });
}
