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
  if (tabs.length === 0) {
    return { showDot: false, state: 'none', label: '', latestActivityAt: 0 };
  }

  const activeTabs = tabs.filter((tab) => !tab?.exited);
  if (activeTabs.length === 0) {
    return { showDot: true, state: 'done', label: 'Done', latestActivityAt: 0 };
  }

  const now = Date.now();
  const lastActivityAt = activeTabs.reduce((latest, tab) => {
    const tabActivity = typeof tab?.getLastActivityAt === 'function'
      ? tab.getLastActivityAt()
      : 0;
    return Math.max(latest, Number(tabActivity) || 0);
  }, 0);
  const currentState = now - lastActivityAt <= IDLE_ACTIVITY_WINDOW_MS ? 'working' : 'idle';
  return {
    showDot: true,
    state: currentState,
    label: currentState === 'working' ? 'Working' : 'Idle',
    latestActivityAt: lastActivityAt,
  };
}

function isProjectAttentionNeeded(projectId, terminalState, isActiveProject) {
  if (!terminalState.showDot || isActiveProject) return false;

  const lastSeenAt = typeof projectId === 'string' && Number(state.projectLastSeenAt[projectId]) ? Number(state.projectLastSeenAt[projectId]) : 0;
  const hadNewActivity = terminalState.latestActivityAt > lastSeenAt;
  if (hadNewActivity) return true;

  const previousState = state.projectTerminalState[projectId];
  if (previousState && previousState !== terminalState.state) return true;

  return false;
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
    const needsAttention = isProjectAttentionNeeded(project.id, terminalState, isActiveProject);
    const shouldRecordState = terminalState.showDot;
    if (shouldRecordState && state.projectTerminalState[project.id] !== terminalState.state) {
      state.projectTerminalState[project.id] = terminalState.state;
    }

    const pulseClass = needsAttention ? ' item-status-dot--attention' : '';
    const terminalDot = terminalState.showDot
      ? `<span class="item-status-dot item-status-dot--${terminalState.state}${pulseClass}" title="${terminalState.label}" aria-label="${terminalState.label}"></span>`
      : '';
    const itemStatus = terminalState.showDot
      ? `<div class="item-status-row"><span class="item-status">${escapeHtml(project.cwd)}</span>${terminalDot}</div>`
      : `<div class="item-status">${escapeHtml(project.cwd)}</div>`;

    return `<div class="sidebar-item ${state.currentItem === project.id ? 'active' : ''}" data-id="${project.id}" data-project-id="${project.id}" draggable="true"><div class="icon">${renderIcon('folder', { size: 16, className: 'sidebar-glyph' })}</div><div class="item-info"><div class="item-name-row"><div class="item-name">${escapeHtml(project.name)}</div></div>${itemStatus}</div></div>`;
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
