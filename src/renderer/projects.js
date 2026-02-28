import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { renderIcon } from './icons.js';
import { showInputModal } from './modal.js';

let selectItemRef = () => {};
const IDLE_ACTIVITY_WINDOW_MS = 120 * 1000;

export function configureProjects({ selectItem }) {
  selectItemRef = selectItem;
}

function getProjectTerminalState(projectTabs) {
  const tabs = Array.isArray(projectTabs) ? projectTabs : [];
  return tabs.map((tab) => {
    const lastActivityAt = typeof tab?.getLastActivityAt === 'function' ? Number(tab.getLastActivityAt()) || 0 : 0;
    const latestActivityAt = lastActivityAt;
    if (tab?.exited) {
      return {
        tabId: tab.id,
        showDot: true,
        state: 'done',
        label: 'Done',
        latestActivityAt,
      };
    }

    const now = Date.now();
    const state = now - lastActivityAt <= IDLE_ACTIVITY_WINDOW_MS ? 'working' : 'idle';
    return {
      tabId: tab.id,
      showDot: true,
      state,
      label: state === 'working' ? 'Working' : 'Idle',
      latestActivityAt,
    };
  });
}

function isProjectAttentionNeeded(projectId, terminalState, isActiveProject, previousProjectState) {
  if (!terminalState.showDot || isActiveProject) return false;

  const lastSeenAt = typeof projectId === 'string' && Number(state.projectLastSeenAt[projectId]) ? Number(state.projectLastSeenAt[projectId]) : 0;
  if (terminalState.latestActivityAt > lastSeenAt) return true;

  const previousState = previousProjectState?.[terminalState.tabId];
  if (!previousState) return false;
  if (previousState.state !== terminalState.state) return true;
  if (terminalState.state === 'done' && previousState.latestActivityAt !== terminalState.latestActivityAt) return true;

  return false;
}

function getProjectTerminalStateLabel(terminalStates) {
  if (!terminalStates.length) return '';
  const stateWeight = { done: 0, idle: 1, working: 2 };
  const dominant = terminalStates.reduce((acc, item) => {
    if ((stateWeight[item.state] || 0) > (stateWeight[acc.state] || 0)) return item;
    return acc;
  }, terminalStates[0]);
  return `Terminals: ${terminalStates.length} (${dominant.label})`;
}

export function markProjectAsSeen(projectId) {
  if (!projectId || projectId === 'openclaw') return;
  state.projectLastSeenAt[projectId] = Date.now();
  renderProjects();
}

async function persistProjects() {
  await window.tgclaw.saveProjects(state.projects);
}

export async function addProject() {
  const cwd = await window.tgclaw.openDirectoryDialog();
  if (!cwd) return;
  const defaultName = cwd.split(/[\\/]/).filter(Boolean).pop() || 'Project';
  const name = await showInputModal({ title: 'Project Name', placeholder: 'Enter project name', defaultValue: defaultName });
  if (!name) return;

  const id = `proj-${Date.now()}`;
  state.projects.push({ id, name, cwd });
  await persistProjects();
  renderProjects();
  selectItemRef(id);
}

export function renderProjects() {
  const list = document.getElementById('project-list');
  list.innerHTML = state.projects.map((project) => {
    const projectTabs = state.tabs[project.id] || [];
    const terminalState = getProjectTerminalState(projectTabs);
    const isActiveProject = state.currentItem === project.id;
    const previousProjectState = state.projectTerminalState[project.id] || {};
    const terminalDots = terminalState.map((item, index) => {
      const needsAttention = isProjectAttentionNeeded(project.id, item, isActiveProject, previousProjectState);
      const pulseClass = needsAttention ? ' item-status-dot--attention' : '';
      const title = `${item.label} #${index + 1}`;
      return item.showDot
        ? `<span class="item-status-dot item-status-dot--${item.state}${pulseClass}" title="${title}" aria-label="${title}"></span>`
        : '';
    }).filter(Boolean).join('');

    const nextProjectState = terminalState.reduce((acc, item) => {
      if (!item.showDot) return acc;
      acc[item.tabId] = {
        state: item.state,
        latestActivityAt: item.latestActivityAt,
      };
      return acc;
    }, {});
    state.projectTerminalState[project.id] = nextProjectState;

    const itemStatus = terminalState.length > 0
      ? `<div class="item-status-row"><span class="item-status">${escapeHtml(project.cwd)}</span><div class="item-status-dots">${terminalDots}</div></div>`
      : `<div class="item-status">${escapeHtml(project.cwd)}</div>`;
    const itemStatusLabel = terminalState.length > 0 ? ` title="${getProjectTerminalStateLabel(terminalState)}"` : '';

    return `<div class="sidebar-item ${state.currentItem === project.id ? 'active' : ''}" data-id="${project.id}" data-project-id="${project.id}" draggable="true" ${itemStatusLabel}><div class="icon">${renderIcon('folder', { size: 16, className: 'sidebar-glyph' })}</div><div class="item-info"><div class="item-name-row"><div class="item-name">${escapeHtml(project.name)}</div></div>${itemStatus}</div></div>`;
  }).join('');

  list.querySelectorAll('.sidebar-item[data-project-id]').forEach((item) => {
    const projectId = item.dataset.projectId;
    item.addEventListener('click', () => selectItemRef(projectId));
    item.addEventListener('dragstart', (event) => onProjectDragStart(event, projectId));
    item.addEventListener('dragover', (event) => onProjectDragOver(event, projectId));
    item.addEventListener('drop', (event) => void onProjectDrop(event, projectId));
    item.addEventListener('dragend', onProjectDragEnd);
  });
}

export function deleteProject(projectId) {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) return;
  (state.tabs[projectId] || []).forEach((tab) => tab.cleanup());
  delete state.tabs[projectId];
  delete state.activeTab[projectId];
  delete state.projectTerminalState[projectId];
  delete state.projectLastSeenAt[projectId];
  state.projects.splice(index, 1);
  void persistProjects();
  if (state.currentItem === projectId) selectItemRef('openclaw');
  renderProjects();
}

export async function renameProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  const input = await showInputModal({ title: 'Rename Project', placeholder: 'Enter new name', defaultValue: project.name });
  if (input === null) return;

  const nextName = input.trim();
  if (!nextName || nextName === project.name) return;
  project.name = nextName;
  await persistProjects();
  renderProjects();
}

function clearProjectDropIndicators() {
  document.querySelectorAll('.sidebar-item[data-project-id]').forEach((el) => el.classList.remove('drag-over-before', 'drag-over-after'));
}

export function onProjectDragStart(event, projectId) {
  state.dragProjectState = { projectId };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', projectId);
  event.currentTarget.classList.add('dragging');
}

export function onProjectDragOver(event, targetProjectId) {
  if (!state.dragProjectState.projectId || state.dragProjectState.projectId === targetProjectId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearProjectDropIndicators();
  const rect = event.currentTarget.getBoundingClientRect();
  const dropAfter = event.clientY > rect.top + rect.height / 2;
  event.currentTarget.classList.add(dropAfter ? 'drag-over-after' : 'drag-over-before');
}

export async function onProjectDrop(event, targetProjectId) {
  event.preventDefault();
  const sourceProjectId = state.dragProjectState.projectId;
  if (!sourceProjectId || sourceProjectId === targetProjectId) return onProjectDragEnd();

  const sourceIndex = state.projects.findIndex((project) => project.id === sourceProjectId);
  const targetIndex = state.projects.findIndex((project) => project.id === targetProjectId);
  if (sourceIndex < 0 || targetIndex < 0) return onProjectDragEnd();

  const rect = event.currentTarget.getBoundingClientRect();
  let nextIndex = targetIndex + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
  if (sourceIndex < nextIndex) nextIndex -= 1;

  const [movedProject] = state.projects.splice(sourceIndex, 1);
  state.projects.splice(nextIndex, 0, movedProject);
  onProjectDragEnd();
  renderProjects();
  await persistProjects();
}

export function onProjectDragEnd() {
  state.dragProjectState = { projectId: null };
  document.querySelectorAll('.sidebar-item[data-project-id]').forEach((el) => el.classList.remove('dragging'));
  clearProjectDropIndicators();
}
