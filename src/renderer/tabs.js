import { state } from './state.js';
import { agentLabel, escapeHtml } from './utils.js';
import { renderAgentIcon, renderIcon } from './icons.js';
import { closeTerminalSearch, createTerminal, hideAllTerminals, showTerminal } from './terminal.js';
const deps = { renderProjects: () => {}, updateWindowTitle: () => {} };
let agentPickerSelectionLocked = false;
let addTabHoverHideTimer = null;
let addTabDefaultAgent = 'shell';
const ADD_TAB_DEFAULT_KEY = 'tgclaw:add-tab-default-agent';
const terminalActivityDebounce = new Map();
export function configureTabs(nextDeps) { Object.assign(deps, nextDeps); }

function scheduleProjectListRefresh(projectId) {
  if (!projectId) return;
  const existed = terminalActivityDebounce.get(projectId);
  if (existed) clearTimeout(existed);
  terminalActivityDebounce.set(projectId, setTimeout(() => {
    terminalActivityDebounce.delete(projectId);
    deps.renderProjects();
  }, 500));
}

function onProjectOutput(projectId) {
  scheduleProjectListRefresh(projectId);
}
function normalizeCommand(command) {
  if (typeof command !== 'string') return '';
  return command.trim();
}

function normalizeCommandArgs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return item;
    if (item == null) return '';
    return String(item);
  }).filter(Boolean);
}

function normalizeCommandType(type, command) {
  const normalizedCommand = normalizeCommand(command);
  return normalizedCommand || type;
}

function shouldSelectProject(projectId) {
  return typeof projectId === 'string' && projectId.trim();
}
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
export async function addAgentTab(type, options = {}) {
  hideAgentPicker();
  const targetProjectId = shouldSelectProject(options.projectId) ? options.projectId : state.currentItem;
  const project = state.projects.find((item) => item.id === targetProjectId);
  if (!project) return;
  const command = normalizeCommand(options.command);
  const commandArgs = normalizeCommandArgs(options.commandArgs);
  const tabType = normalizeCommandType(type, command);

  const tabId = `tab-${Date.now()}`;
  if (!state.tabs[project.id]) state.tabs[project.id] = [];
  const terminal = await createTerminal({
    tabId,
    type: tabType,
    command,
    commandArgs,
    project,
    onOutput: () => onProjectOutput(project.id),
    onExit: () => {
      const tab = (state.tabs[project.id] || []).find((item) => item.id === tabId);
      if (!tab) return;
      tab.exited = true;
      deps.renderProjects();
      if (state.currentItem === project.id) renderTabs(project.id);
    },
    onRestart: () => {
      closeTab(project.id, tabId);
      addAgentTab(type, {
        command,
        commandArgs,
        projectId: project.id,
      });
    },
  });
  state.tabs[project.id].push({ id: tabId, type: tabType, customName: '', ...terminal });
  state.activeTab[project.id] = tabId;

  const isActiveProject = state.currentItem === project.id;
  if (isActiveProject) {
    renderTabs(project.id);
  }
  deps.renderProjects();
  deps.updateWindowTitle();
  if (isActiveProject) {
    setTimeout(() => terminal.fitAddon.fit(), 150);
  }
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

function getAddTabDefaultAnchor() {
  return document.getElementById('tab-add-default-anchor');
}

function getAddTabDefaultSubmenu() {
  return document.getElementById('add-tab-default-submenu');
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

function positionAddTabDefaultSubmenu() {
  const anchor = getAddTabDefaultAnchor();
  const submenu = getAddTabDefaultSubmenu();
  if (!anchor || !submenu) return;

  const rect = anchor.getBoundingClientRect();
  const submenuWidth = submenu.offsetWidth || 190;
  const submenuHeight = submenu.offsetHeight || 280;
  let left = rect.right + 4;
  if (left + submenuWidth > window.innerWidth - 8) left = rect.left - submenuWidth - 4;
  left = Math.max(8, left);

  let top = rect.top;
  if (top + submenuHeight > window.innerHeight - 8) top = window.innerHeight - submenuHeight - 8;
  top = Math.max(8, top);

  submenu.style.left = `${Math.round(left)}px`;
  submenu.style.top = `${Math.round(top)}px`;
}

function showAddTabDefaultSubmenu() {
  clearAddTabHoverHideTimer();
  const menu = getAddTabHoverMenu();
  const anchor = getAddTabDefaultAnchor();
  const submenu = getAddTabDefaultSubmenu();
  if (!menu?.classList.contains('show') || !anchor || !submenu) return;
  submenu.classList.add('show');
  anchor.setAttribute('aria-expanded', 'true');
  positionAddTabDefaultSubmenu();
}

function hideAddTabDefaultSubmenu() {
  const anchor = getAddTabDefaultAnchor();
  const submenu = getAddTabDefaultSubmenu();
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  if (submenu) submenu.classList.remove('show');
}

function showAddTabHoverMenu() {
  clearAddTabHoverHideTimer();
  const menu = getAddTabHoverMenu();
  if (!menu) return;
  hideAddTabDefaultSubmenu();
  menu.classList.add('show');
  positionAddTabHoverMenu();
  updateAddTabDefaultUi();
}

function hideAddTabHoverMenu() {
  clearAddTabHoverHideTimer();
  hideAddTabDefaultSubmenu();
  const menu = getAddTabHoverMenu();
  if (!menu) return;
  menu.classList.remove('show');
}

function scheduleHideAddTabHoverMenu() {
  clearAddTabHoverHideTimer();
  addTabHoverHideTimer = setTimeout(() => hideAddTabHoverMenu(), 180);
}

function getAddTabOptionTypes() {
  const fromSubmenu = Array.from(document.querySelectorAll('#add-tab-default-submenu .tab-add-default-option[data-agent-type]'))
    .map((option) => option.dataset.agentType)
    .filter(Boolean);
  if (fromSubmenu.length > 0) return fromSubmenu;
  return Array.from(document.querySelectorAll('#add-tab-hover-menu .tab-add-option[data-agent-type]'))
    .map((option) => option.dataset.agentType)
    .filter(Boolean);
}

function resolveDefaultAgent() {
  const optionTypes = getAddTabOptionTypes();
  if (optionTypes.length === 0) return 'shell';
  const saved = localStorage.getItem(ADD_TAB_DEFAULT_KEY);
  if (saved && optionTypes.includes(saved)) return saved;
  if (optionTypes.includes('shell')) return 'shell';
  return optionTypes[0];
}

function updateAddTabDefaultUi() {
  const label = agentLabel(addTabDefaultAgent);
  const addTabButton = document.getElementById('add-tab');
  const badge = document.getElementById('add-tab-default-badge');
  const defaultValue = document.getElementById('tab-add-default-value');
  if (addTabButton) addTabButton.title = `New Tab (${label})`;
  if (badge) badge.textContent = `Default: ${label}`;
  if (defaultValue) defaultValue.textContent = label;

  document.querySelectorAll('#add-tab-default-submenu .tab-add-default-option').forEach((option) => {
    const isDefault = option.dataset.agentType === addTabDefaultAgent;
    option.classList.toggle('is-default', isDefault);
  });
}

function setDefaultAgent(type) {
  if (!type || typeof type !== 'string') return;
  addTabDefaultAgent = type;
  localStorage.setItem(ADD_TAB_DEFAULT_KEY, type);
  updateAddTabDefaultUi();
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
  const addTabDefaultAnchor = getAddTabDefaultAnchor();
  const addTabDefaultSubmenu = getAddTabDefaultSubmenu();
  if (addTabButton && addTabHoverMenu && addTabDefaultAnchor && addTabDefaultSubmenu) {
    addTabDefaultAgent = resolveDefaultAgent();
    updateAddTabDefaultUi();

    addTabButton.addEventListener('mouseenter', () => showAddTabHoverMenu());
    addTabButton.addEventListener('mouseleave', () => scheduleHideAddTabHoverMenu());
    addTabButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideAddTabHoverMenu();
      void addAgentTab(addTabDefaultAgent);
    });

    addTabHoverMenu.addEventListener('mouseenter', () => clearAddTabHoverHideTimer());
    addTabHoverMenu.addEventListener('mouseleave', () => scheduleHideAddTabHoverMenu());
    addTabHoverMenu.querySelectorAll('.tab-add-option').forEach((option) => option.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const type = option.dataset.agentType;
      if (!type || agentPickerSelectionLocked) return;
      agentPickerSelectionLocked = true;
      option.classList.add('pick-feedback');
      setTimeout(() => {
        option.classList.remove('pick-feedback');
        hideAddTabHoverMenu();
        void addAgentTab(type);
        agentPickerSelectionLocked = false;
      }, 120);
    }));

    addTabDefaultAnchor.addEventListener('mouseenter', () => showAddTabDefaultSubmenu());
    addTabDefaultAnchor.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showAddTabDefaultSubmenu();
    });
    addTabDefaultSubmenu.addEventListener('mouseenter', () => clearAddTabHoverHideTimer());
    addTabDefaultSubmenu.addEventListener('mouseleave', () => scheduleHideAddTabHoverMenu());
    addTabDefaultSubmenu.querySelectorAll('.tab-add-default-option').forEach((option) => option.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const type = option.dataset.agentType;
      if (!type || agentPickerSelectionLocked) return;
      agentPickerSelectionLocked = true;
      option.classList.add('pick-feedback');
      setTimeout(() => {
        option.classList.remove('pick-feedback');
        setDefaultAgent(type);
        hideAddTabHoverMenu();
        agentPickerSelectionLocked = false;
      }, 120);
    }));

    document.addEventListener('click', (event) => {
      if (
        addTabButton.contains(event.target)
        || addTabHoverMenu.contains(event.target)
        || addTabDefaultSubmenu.contains(event.target)
      ) return;
      hideAddTabHoverMenu();
    });

    window.addEventListener('resize', () => {
      if (addTabHoverMenu.classList.contains('show')) positionAddTabHoverMenu();
      if (addTabDefaultSubmenu.classList.contains('show')) positionAddTabDefaultSubmenu();
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
