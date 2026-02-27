import { state } from './state.js';
import { agentEmoji, agentLabel, escapeHtml } from './utils.js';
import { closeTerminalSearch, createTerminal, hideAllTerminals, showTerminal } from './terminal.js';

const deps = { renderProjects: () => {}, selectItem: () => {}, updateWindowTitle: () => {} };
let agentPickerSelectionLocked = false;

export function configureTabs(nextDeps) { Object.assign(deps, nextDeps); }
export function getTabDisplayName(tab) { return tab.customName || `${agentEmoji(tab.type)} ${agentLabel(tab.type)}`; }
function isTabRenaming(projectId, tabId) { return state.tabRenameState.projectId === projectId && state.tabRenameState.tabId === tabId; }

export function onTabTitleDoubleClick(event, projectId, tabId) {
  event.stopPropagation();
  state.tabRenameState = { projectId, tabId };
  renderTabs(projectId);
}

export function finishTabRename(projectId, tabId, inputValue) {
  if (!isTabRenaming(projectId, tabId)) return;
  const tab = (state.tabs[projectId] || []).find((t) => t.id === tabId);
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
  const projectTabs = state.tabs[projectId] || [];
  const active = state.activeTab[projectId];
  const tabList = document.getElementById('tab-list');
  tabList.innerHTML = projectTabs.map((tab) => {
    const title = isTabRenaming(projectId, tab.id)
      ? `<input class="tab-rename-input" type="text" value="${escapeHtml(getTabDisplayName(tab))}" data-tab-id="${tab.id}" onclick="event.stopPropagation()" ondblclick="event.stopPropagation()" onkeydown="onTabRenameKeydown(event, '${projectId}', '${tab.id}')" onblur="finishTabRename('${projectId}', '${tab.id}', this.value)" />`
      : `<span class="tab-title" ondblclick="onTabTitleDoubleClick(event, '${projectId}', '${tab.id}')">${escapeHtml(getTabDisplayName(tab))}</span>`;
    return `<div class="tab ${tab.id === active ? 'active' : ''}" draggable="true" onclick="switchTab('${projectId}', '${tab.id}')" oncontextmenu="onTabContextMenu(event, '${projectId}', '${tab.id}')" ondragstart="onTabDragStart(event, '${projectId}', '${tab.id}')" ondragover="onTabDragOver(event, '${projectId}', '${tab.id}')" ondrop="onTabDrop(event, '${projectId}', '${tab.id}')" ondragend="onTabDragEnd()">${title}${tab.exited ? '<span class="tab-exited-flag">[Exited]</span>' : ''}<span class="close-tab" onclick="event.stopPropagation(); closeTab('${projectId}', '${tab.id}')">✕</span></div>`;
  }).join('');

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

export async function addAgentTab(type) {
  hideAgentPicker();
  const project = state.projects.find((item) => item.id === state.currentItem);
  if (!project) return;

  const tabId = `tab-${Date.now()}`;
  if (!state.tabs[project.id]) state.tabs[project.id] = [];
  const terminal = await createTerminal({
    tabId,
    type,
    project,
    onExit: () => {
      const tab = (state.tabs[project.id] || []).find((item) => item.id === tabId);
      if (!tab) return;
      tab.exited = true;
      deps.renderProjects();
      if (state.currentItem === project.id) renderTabs(project.id);
    },
  });

  state.tabs[project.id].push({ id: tabId, type, customName: '', ...terminal });
  state.activeTab[project.id] = tabId;
  renderTabs(project.id);
  deps.renderProjects();
  deps.updateWindowTitle();
  setTimeout(() => terminal.fitAddon.fit(), 150);
}

export function closeTab(projectId, tabId) {
  const projectTabs = state.tabs[projectId] || [];
  const index = projectTabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;
  if (isTabRenaming(projectId, tabId)) state.tabRenameState = { projectId: null, tabId: null };
  projectTabs[index].cleanup();
  projectTabs.splice(index, 1);
  if (state.activeTab[projectId] === tabId) state.activeTab[projectId] = projectTabs.length > 0 ? projectTabs[projectTabs.length - 1].id : null;
  renderTabs(projectId);
  deps.renderProjects();
  deps.updateWindowTitle();
}

function clearTabDropIndicators() {
  document.querySelectorAll('.tab').forEach((tabEl) => tabEl.classList.remove('drag-over-before', 'drag-over-after'));
}

export function onTabDragStart(event, projectId, tabId) {
  if (isTabRenaming(projectId, tabId)) return event.preventDefault();
  state.dragTabState = { projectId, tabId };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', tabId);
  event.currentTarget.classList.add('dragging');
}

export function onTabDragOver(event, projectId, targetTabId) {
  if (state.dragTabState.projectId !== projectId || state.dragTabState.tabId === targetTabId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearTabDropIndicators();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.classList.add(event.clientX > rect.left + rect.width / 2 ? 'drag-over-after' : 'drag-over-before');
}

export function onTabDrop(event, projectId, targetTabId) {
  event.preventDefault();
  if (state.dragTabState.projectId !== projectId) return onTabDragEnd();
  const projectTabs = state.tabs[projectId] || [];
  const from = projectTabs.findIndex((tab) => tab.id === state.dragTabState.tabId);
  const to = projectTabs.findIndex((tab) => tab.id === targetTabId);
  if (from < 0 || to < 0 || from === to) return onTabDragEnd();

  const rect = event.currentTarget.getBoundingClientRect();
  let next = to + (event.clientX > rect.left + rect.width / 2 ? 1 : 0);
  if (from < next) next -= 1;
  const [movedTab] = projectTabs.splice(from, 1);
  projectTabs.splice(next, 0, movedTab);
  onTabDragEnd();
  renderTabs(projectId);
}

export function onTabDragEnd() {
  state.dragTabState = { projectId: null, tabId: null };
  document.querySelectorAll('.tab').forEach((tabEl) => tabEl.classList.remove('dragging'));
  clearTabDropIndicators();
}

export function showAgentPicker() {
  agentPickerSelectionLocked = false;
  document.getElementById('agent-picker').classList.add('show');
}

export function hideAgentPicker() {
  agentPickerSelectionLocked = false;
  document.getElementById('agent-picker').classList.remove('show');
}

export function initAgentPicker() {
  document.getElementById('agent-picker').addEventListener('click', (event) => {
    if (event.target.id === 'agent-picker') hideAgentPicker();
  });
  document.querySelectorAll('.agent-option').forEach((option) => {
    option.addEventListener('click', () => {
      const type = option.dataset.agentType;
      if (!type || agentPickerSelectionLocked) return;
      agentPickerSelectionLocked = true;
      option.classList.add('pick-feedback');
      setTimeout(() => {
        option.classList.remove('pick-feedback');
        addAgentTab(type);
      }, 180);
    });
  });
}
