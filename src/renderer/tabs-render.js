import { state } from './state.js';
import { agentLabel, escapeHtml } from './utils.js';
import { renderAgentIcon, renderIcon } from './icons.js';
import { closeTerminalSearch, hideAllTerminals, showTerminal } from './terminal.js';
import { onTabDragEnd, onTabDragOver, onTabDragStart, onTabDrop } from './tabs-drag-drop.js';

const deps = {
  closeTab: () => {},
  updateWindowTitle: () => {},
};

export function configureTabsRender(nextDeps) {
  Object.assign(deps, nextDeps);
}

export function getTabDisplayName(tab) {
  return tab.customName || agentLabel(tab.type);
}

export function isTabRenaming(projectId, tabId) {
  return state.tabRenameState.projectId === projectId && state.tabRenameState.tabId === tabId;
}

export function onTabTitleDoubleClick(event, projectId, tabId) {
  event.stopPropagation();
  state.tabRenameState = { projectId, tabId };
  renderTabs(projectId);
}

export function finishTabRename(projectId, tabId, inputValue) {
  if (!isTabRenaming(projectId, tabId)) return;
  const tab = (state.tabs[projectId] || []).find((item) => item.id === tabId);
  if (tab) tab.customName = String(inputValue || '').trim();
  state.tabRenameState = { projectId: null, tabId: null };
  renderTabs(projectId);
  deps.updateWindowTitle();
}

export function onTabRenameKeydown(event, projectId, tabId) {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    finishTabRename(projectId, tabId, event.currentTarget.value);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    state.tabRenameState = { projectId: null, tabId: null };
    renderTabs(projectId);
  }
}

export function renderTabs(projectId) {
  if (state.currentItem !== projectId) return;
  const projectTabs = state.tabs[projectId] || [];
  const active = state.activeTab[projectId];
  const tabList = document.getElementById('tab-list');
  tabList.innerHTML = projectTabs.map((tab) => {
    const icon = renderAgentIcon(tab.type, { size: 14, className: 'tab-agent-icon' });
    const title = isTabRenaming(projectId, tab.id)
      ? `<input class="tab-rename-input" type="text" value="${escapeHtml(getTabDisplayName(tab))}" data-tab-id="${tab.id}" />`
      : `<span class="tab-title-row">${icon}<span class="tab-title" data-tab-id="${tab.id}">${escapeHtml(getTabDisplayName(tab))}</span></span>`;
    return `<div class="tab ${tab.id === active ? 'active' : ''}" data-tab-id="${tab.id}" draggable="true">${title}${tab.exited ? '<span class="tab-exited-flag">[Exited]</span>' : ''}<span class="close-tab" data-tab-id="${tab.id}">${renderIcon('close', { size: 12, className: 'tab-close-icon' })}</span></div>`;
  }).join('');
  tabList.querySelectorAll('.tab').forEach((tabEl) => {
    const tabId = tabEl.dataset.tabId;
    tabEl.addEventListener('click', () => switchTab(projectId, tabId));
    tabEl.addEventListener('contextmenu', (event) => onTabContextMenu(event, projectId, tabId));
    tabEl.addEventListener('dragstart', (event) => onTabDragStart(event, projectId, tabId));
    tabEl.addEventListener('dragover', (event) => onTabDragOver(event, projectId, tabId));
    tabEl.addEventListener('drop', (event) => onTabDrop(event, projectId, tabId));
    tabEl.addEventListener('dragend', onTabDragEnd);
  });
  tabList.querySelectorAll('.close-tab').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    deps.closeTab(projectId, button.dataset.tabId);
  }));
  tabList.querySelectorAll('.tab-title').forEach((titleEl) => titleEl.addEventListener('dblclick', (event) => {
    onTabTitleDoubleClick(event, projectId, titleEl.dataset.tabId);
  }));
  tabList.querySelectorAll('.tab-rename-input').forEach((input) => {
    const tabId = input.dataset.tabId;
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('dblclick', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => onTabRenameKeydown(event, projectId, tabId));
    input.addEventListener('blur', () => finishTabRename(projectId, tabId, input.value));
  });
  if (state.tabRenameState.projectId === projectId && state.tabRenameState.tabId) {
    const input = tabList.querySelector(`.tab-rename-input[data-tab-id="${state.tabRenameState.tabId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }
  hideAllTerminals();
  if (active) showTerminal(projectTabs.find((tab) => tab.id === active));
  else if (state.terminalSearchVisible) closeTerminalSearch();
}

export function switchTab(projectId, tabId) {
  state.activeTab[projectId] = tabId;
  renderTabs(projectId);
  deps.updateWindowTitle();
  const tab = (state.tabs[projectId] || []).find((item) => item.id === tabId);
  if (tab?.fitAddon) setTimeout(() => tab.fitAddon.fit(), 50);
}

export function onTabContextMenu(event, projectId, tabId) {
  event.preventDefault();
  const tab = (state.tabs[projectId] || []).find((item) => item.id === tabId);
  if (!tab) return;
  window.tgclaw.showTabContextMenu({ projectId, tabId, tabType: tab.type, tabName: getTabDisplayName(tab) });
}

export function getActiveProjectTab(projectId = state.currentItem) {
  const active = state.activeTab[projectId];
  return (state.tabs[projectId] || []).find((tab) => tab.id === active) || null;
}
