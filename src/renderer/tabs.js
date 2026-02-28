import { state } from './state.js';
import { agentLabel, escapeHtml } from './utils.js';
import { renderAgentIcon, renderIcon } from './icons.js';
import { closeTerminalSearch, createTerminal, hideAllTerminals, showTerminal } from './terminal.js';
import { configureTabDragDrop, onTabDragEnd, onTabDragOver, onTabDragStart, onTabDrop } from './tabs-drag-drop.js';
import { hideAgentPicker, initAgentPicker as initAgentPickerBase, showAgentPicker } from './tabs-hover-menu.js';
const deps = { renderProjects: () => {}, updateWindowTitle: () => {} };
const terminalActivityDebounce = new Map();
export function configureTabs(nextDeps) {
  Object.assign(deps, nextDeps);
  configureTabDragDrop({ isTabRenaming, renderTabs });
}
function scheduleProjectListRefresh(projectId) {
  if (!projectId) return;
  const existed = terminalActivityDebounce.get(projectId);
  if (existed) clearTimeout(existed);
  terminalActivityDebounce.set(projectId, setTimeout(() => {
    terminalActivityDebounce.delete(projectId);
    deps.renderProjects();
  }, 500));
}
function onProjectOutput(projectId) { scheduleProjectListRefresh(projectId); }
function normalizeCommand(command) { return typeof command === 'string' ? command.trim() : ''; }
function normalizeCommandArgs(value) { return Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : (item == null ? '' : String(item)))).filter(Boolean) : []; }
function normalizeCommandType(type, command) { return normalizeCommand(command) || type; }
function normalizeTerminalSessionId(value) { return typeof value === 'string' ? value.trim() : ''; }
function findTabBySessionId(terminalSessionId) {
  const sessionId = normalizeTerminalSessionId(terminalSessionId);
  if (!sessionId) return null;
  for (const [projectId, projectTabs] of Object.entries(state.tabs)) {
    const matched = (projectTabs || []).find((tab) => normalizeTerminalSessionId(tab.terminalSessionId) === sessionId);
    if (matched) return { projectId, tab: matched };
  }
  return null;
}
function shouldSelectProject(projectId) { return typeof projectId === 'string' && projectId.trim(); }
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
    closeTab(projectId, button.dataset.tabId);
  }));
  tabList.querySelectorAll('.tab-title').forEach((titleEl) => titleEl.addEventListener('dblclick', (event) => onTabTitleDoubleClick(event, projectId, titleEl.dataset.tabId)));
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
export async function addAgentTab(type, options = {}) {
  hideAgentPicker();
  const targetProjectId = shouldSelectProject(options.projectId) ? options.projectId : state.currentItem;
  const project = state.projects.find((item) => item.id === targetProjectId);
  if (!project) return;
  const terminalRequest = options.terminalRequest && typeof options.terminalRequest === 'object' ? options.terminalRequest : null;
  const captureExecution = options.captureExecution && typeof options.captureExecution === 'object' ? options.captureExecution : null;
  const requestCommand = normalizeCommand(terminalRequest?.command);
  const requestArgs = normalizeCommandArgs(terminalRequest?.args);
  const command = normalizeCommand(options.command) || requestCommand;
  const commandArgs = normalizeCommandArgs(options.commandArgs).length > 0 ? normalizeCommandArgs(options.commandArgs) : requestArgs;
  const requestedSessionId = normalizeTerminalSessionId(options.terminalSessionId || terminalRequest?.terminalSessionId);
  const existing = findTabBySessionId(requestedSessionId);
  if (existing) {
    state.currentItem = existing.projectId;
    state.activeTab[existing.projectId] = existing.tab.id;
    renderTabs(existing.projectId);
    deps.renderProjects();
    deps.updateWindowTitle();
    return existing.tab;
  }
  const isActiveProject = state.currentItem === project.id;
  const tabType = normalizeCommandType(type, command);
  const tabId = `tab-${Date.now()}`;
  if (!state.tabs[project.id]) state.tabs[project.id] = [];
  const terminal = await createTerminal({
    tabId,
    type: tabType,
    command,
    commandArgs,
    captureExecution,
    terminalSessionId: requestedSessionId,
    terminalRequest,
    keepAliveOnCleanup: options.keepAliveOnCleanup === true,
    project,
    visible: isActiveProject,
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
      addAgentTab(type, { command, commandArgs, projectId: project.id });
    },
  });
  const tabRecord = { id: tabId, type: tabType, customName: '', terminalSessionId: normalizeTerminalSessionId(terminal?.terminalSessionId || requestedSessionId), ...terminal };
  state.tabs[project.id].push(tabRecord);
  state.activeTab[project.id] = tabId;
  if (isActiveProject) renderTabs(project.id);
  deps.renderProjects();
  deps.updateWindowTitle();
  if (isActiveProject) setTimeout(() => terminal.fitAddon.fit(), 150);
  return tabRecord;
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
  if (state.currentItem === projectId) renderTabs(projectId);
  deps.renderProjects();
  deps.updateWindowTitle();
}
export function initAgentPicker() { initAgentPickerBase({ addAgentTab }); }
export { hideAgentPicker, showAgentPicker };
