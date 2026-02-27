import { state } from './state.js';
import { escapeHtml } from './utils.js';

const deps = {
  renderTabs: () => {},
  hideAllTerminals: () => {},
  closeTerminalSearch: () => {},
  updateWindowTitle: () => {},
};

export function configureSidebar(nextDeps) {
  Object.assign(deps, nextDeps);
}

async function persistProjects() {
  await window.tgclaw.saveProjects(state.projects);
}

export function updateOpenClawBadge() {
  const badge = document.getElementById('openclaw-badge');
  if (!badge) return;

  if (state.unreadCount > 0) {
    badge.textContent = String(state.unreadCount);
    badge.style.display = 'inline-flex';
    return;
  }

  badge.textContent = '';
  badge.style.display = 'none';
}

export function selectItem(id) {
  state.currentItem = id;
  document.querySelectorAll('.sidebar-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  if (id === 'openclaw') {
    state.unreadCount = 0;
    updateOpenClawBadge();
    document.getElementById('tabbar').style.display = 'none';
    document.getElementById('chat-panel').classList.add('active');
    deps.closeTerminalSearch();
    deps.hideAllTerminals();
  } else {
    document.getElementById('tabbar').style.display = 'flex';
    document.getElementById('chat-panel').classList.remove('active');
    deps.renderTabs(id);
  }

  deps.updateWindowTitle();
}

export async function addProject() {
  const cwd = await window.tgclaw.openDirectoryDialog();
  if (!cwd) return;

  const defaultName = cwd.split(/[\\/]/).filter(Boolean).pop() || 'Project';
  const name = prompt('Project name:', defaultName);
  if (!name) return;

  const id = `proj-${Date.now()}`;
  state.projects.push({ id, name, cwd });
  await persistProjects();
  renderProjects();
  selectItem(id);
}

export function renderProjects() {
  const list = document.getElementById('project-list');
  list.innerHTML = state.projects.map((project) => {
    const activeCount = (state.tabs[project.id] || []).filter((tab) => !tab.exited).length;
    return `<div class="sidebar-item ${state.currentItem === project.id ? 'active' : ''}" data-id="${project.id}" data-project-id="${project.id}" draggable="true"><div class="icon">📁</div><div class="item-info"><div class="item-name-row"><div class="item-name">${escapeHtml(project.name)}</div>${activeCount > 0 ? `<span class="item-badge">${activeCount}</span>` : ''}</div><div class="item-status">${escapeHtml(project.cwd)}</div></div></div>`;
  }).join('');

  list.querySelectorAll('.sidebar-item[data-project-id]').forEach((item) => {
    const projectId = item.dataset.projectId;
    item.addEventListener('click', () => selectItem(projectId));
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
  state.projects.splice(index, 1);
  void persistProjects();

  if (state.currentItem === projectId) selectItem('openclaw');
  renderProjects();
}

export async function renameProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;

  const input = prompt('Rename project:', project.name);
  if (input === null) return;

  const nextName = input.trim();
  if (!nextName || nextName === project.name) return;

  project.name = nextName;
  await persistProjects();
  renderProjects();
}

function clearProjectDropIndicators() {
  document.querySelectorAll('.sidebar-item[data-project-id]').forEach((el) => {
    el.classList.remove('drag-over-before', 'drag-over-after');
  });
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

export function initSidebarBindings() {
  document.querySelector('.sidebar-item.pinned[data-id="openclaw"]')?.addEventListener('click', () => {
    selectItem('openclaw');
  });
  document.getElementById('add-project')?.addEventListener('click', () => void addProject());

  document.getElementById('project-list').addEventListener('contextmenu', (event) => {
    const projectItem = event.target.closest('[data-project-id]');
    if (!projectItem) return;
    event.preventDefault();
    window.tgclaw.showProjectContextMenu(projectItem.dataset.projectId);
  });

  window.tgclaw.onProjectDelete(({ projectId }) => deleteProject(projectId));
  window.tgclaw.onProjectRename(({ projectId }) => void renameProject(projectId));
}
