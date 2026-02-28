import { state } from './state.js';

const deps = {
  isTabRenaming: () => false,
  renderTabs: () => {},
};

export function configureTabsDragDrop(nextDeps) {
  Object.assign(deps, nextDeps);
}

export function clearTabDropIndicators() {
  document.querySelectorAll('.tab').forEach((tabEl) => tabEl.classList.remove('drag-over-before', 'drag-over-after'));
}

export function onTabDragStart(event, projectId, tabId) {
  if (deps.isTabRenaming(projectId, tabId)) return event.preventDefault();
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
  deps.renderTabs(projectId);
}

export function onTabDragEnd() {
  state.dragTabState = { projectId: null, tabId: null };
  document.querySelectorAll('.tab').forEach((tabEl) => tabEl.classList.remove('dragging'));
  clearTabDropIndicators();
}
