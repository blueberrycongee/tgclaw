import { state } from './state.js';
import { agentLabel, escapeHtml } from './utils.js';
import { renderAgentIcon, renderIcon } from './icons.js';
import { closeTerminalSearch, createTerminal, hideAllTerminals, showTerminal } from './terminal.js';
const deps = { renderProjects: () => {}, updateWindowTitle: () => {} };
let agentPickerSelectionLocked = false;
let addTabHoverHideTimer = null;
export function configureTabs(nextDeps) { Object.assign(deps, nextDeps); }
export function getTabDisplayName(tab) { return tab.customName || agentLabel(tab.type); }
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
    closeTab(projectId, button.dataset.tabId);
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
    if (input) { input.focus(); input.select(); }
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
    onRestart: () => {
      closeTab(project.id, tabId);
      addAgentTab(type);
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
  const tab = projectTabs[index];
  if (tab.splitTerminal?.cleanup) tab.splitTerminal.cleanup();
  tab.cleanup();
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

function clearAddTabHoverHideTimer() {
  if (addTabHoverHideTimer) clearTimeout(addTabHoverHideTimer);
  addTabHoverHideTimer = null;
}

function getAddTabHoverMenu() {
  return document.getElementById('add-tab-hover-menu');
}

function positionAddTabHoverMenu() {
  const addTabButton = document.getElementById('add-tab');
  const menu = getAddTabHoverMenu();
  if (!addTabButton || !menu) return;

  const rect = addTabButton.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 190;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 6)}px`;
}

function showAddTabHoverMenu() {
  clearAddTabHoverHideTimer();
  const menu = getAddTabHoverMenu();
  if (!menu) return;
  menu.classList.add('show');
  positionAddTabHoverMenu();
}

function hideAddTabHoverMenu() {
  clearAddTabHoverHideTimer();
  const menu = getAddTabHoverMenu();
  if (!menu) return;
  menu.classList.remove('show');
}

function scheduleHideAddTabHoverMenu() {
  clearAddTabHoverHideTimer();
  addTabHoverHideTimer = setTimeout(() => hideAddTabHoverMenu(), 120);
}

export function showAgentPicker() {
  agentPickerSelectionLocked = false;
  hideAddTabHoverMenu();
  document.getElementById('agent-picker')?.classList.add('show');
}
export function hideAgentPicker() {
  agentPickerSelectionLocked = false;
  document.getElementById('agent-picker')?.classList.remove('show');
  hideAddTabHoverMenu();
}
export function initAgentPicker() {
  const addTabButton = document.getElementById('add-tab');
  const addTabHoverMenu = getAddTabHoverMenu();
  if (addTabButton && addTabHoverMenu) {
    addTabButton.addEventListener('mouseenter', () => showAddTabHoverMenu());
    addTabButton.addEventListener('mouseleave', () => scheduleHideAddTabHoverMenu());
    addTabButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showAddTabHoverMenu();
    });

    addTabHoverMenu.addEventListener('mouseenter', () => clearAddTabHoverHideTimer());
    addTabHoverMenu.addEventListener('mouseleave', () => scheduleHideAddTabHoverMenu());
    addTabHoverMenu.querySelectorAll('.tab-add-option').forEach((option) => option.addEventListener('click', () => {
      const type = option.dataset.agentType;
      if (!type || agentPickerSelectionLocked) return;
      agentPickerSelectionLocked = true;
      option.classList.add('pick-feedback');
      setTimeout(() => {
        option.classList.remove('pick-feedback');
        hideAddTabHoverMenu();
        addAgentTab(type);
        agentPickerSelectionLocked = false;
      }, 120);
    }));

    document.addEventListener('click', (event) => {
      if (addTabButton.contains(event.target) || addTabHoverMenu.contains(event.target)) return;
      hideAddTabHoverMenu();
    });

    window.addEventListener('resize', () => {
      if (!addTabHoverMenu.classList.contains('show')) return;
      positionAddTabHoverMenu();
    });
  }

  document.getElementById('agent-picker')?.addEventListener('click', (event) => {
    if (event.target.id === 'agent-picker') hideAgentPicker();
  });
  document.querySelectorAll('#agent-picker .agent-option').forEach((option) => option.addEventListener('click', () => {
    const type = option.dataset.agentType;
    if (!type || agentPickerSelectionLocked) return;
    agentPickerSelectionLocked = true;
    option.classList.add('pick-feedback');
    setTimeout(() => {
      option.classList.remove('pick-feedback');
      addAgentTab(type);
    }, 180);
  }));
}
