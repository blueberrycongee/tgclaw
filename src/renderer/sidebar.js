import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { updateEmptyState } from './chat-messages.js';
import { showInputModal } from './modal.js';
import { addProject, configureProjects, deleteProject, renameProject } from './projects.js';
import { removeCachedSession, upsertCachedSession } from './chat-cache.js';

const deps = {
  renderTabs: () => {},
  hideAllTerminals: () => {},
  closeTerminalSearch: () => {},
  updateWindowTitle: () => {},
  reloadChatHistory: () => {},
  updateChatHeader: () => {},
};

export function configureSidebar(nextDeps) { Object.assign(deps, nextDeps); }

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
  const isSessionItem = id.startsWith('session:');
  const nextSessionKey = isSessionItem ? id.slice('session:'.length) : id === 'openclaw' ? 'default' : null;
  const shouldReloadHistory = typeof nextSessionKey === 'string' && state.currentSessionKey !== nextSessionKey;
  if (typeof nextSessionKey === 'string') {
    state.currentSessionKey = nextSessionKey;
    localStorage.setItem('tgclaw:lastSessionKey', nextSessionKey);
    deps.updateChatHeader();
  }

  state.currentItem = id;
  const tabbar = document.getElementById('tabbar');
  const quickLaunchBar = document.getElementById('quick-launch-bar');
  const chatPanel = document.getElementById('chat-panel');
  document.querySelectorAll('.sidebar-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  if (id === 'openclaw' || isSessionItem) {
    state.unreadCount = 0;
    updateOpenClawBadge();
    if (tabbar) tabbar.style.display = 'none';
    if (quickLaunchBar) quickLaunchBar.style.display = 'none';
    if (chatPanel) chatPanel.classList.add('active');
    deps.closeTerminalSearch();
    deps.hideAllTerminals();
    if (shouldReloadHistory) deps.reloadChatHistory();
  } else {
    if (tabbar) tabbar.style.display = 'flex';
    if (quickLaunchBar) quickLaunchBar.style.display = 'flex';
    if (chatPanel) chatPanel.classList.remove('active');
    deps.renderTabs(id);
  }

  deps.updateWindowTitle();
}

configureProjects({ selectItem });

export function renderSessions() {
  const list = document.getElementById('session-list');
  if (!list) return;

  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const displaySessions = sessions.filter((session) => (
    session
    && typeof session.sessionKey === 'string'
    && session.sessionKey
    && session.sessionKey !== 'default'
  ));

  list.innerHTML = displaySessions.map((session) => {
    const sessionKey = session.sessionKey;
    const label = typeof session.label === 'string' && session.label.trim() ? session.label : sessionKey;
    const itemId = `session:${sessionKey}`;
    return `<div class="sidebar-item ${state.currentItem === itemId ? 'active' : ''}" data-id="${itemId}" data-session-key="${escapeHtml(sessionKey)}"><div class="icon">💬</div><div class="item-info"><div class="item-name">${escapeHtml(label)}</div></div></div>`;
  }).join('');

  list.querySelectorAll('.sidebar-item[data-session-key]').forEach((item) => {
    const sessionKey = item.dataset.sessionKey;
    item.addEventListener('click', () => selectItem(`session:${sessionKey}`));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      window.tgclaw.showSessionContextMenu(sessionKey);
    });
  });
}

function deleteSession(sessionKey) {
  const index = state.sessions.findIndex((session) => session?.sessionKey === sessionKey);
  if (index === -1) return;
  state.sessions.splice(index, 1);
  removeCachedSession(sessionKey);
  if (state.currentItem === `session:${sessionKey}`) selectItem('openclaw');
  renderSessions();
}

async function renameSession(sessionKey) {
  const session = state.sessions.find((item) => item?.sessionKey === sessionKey);
  if (!session) return;
  const input = await showInputModal({
    title: 'Rename Session',
    placeholder: 'Enter new name',
    defaultValue: session.label,
  });
  if (input === null) return;

  const nextLabel = input.trim();
  if (!nextLabel || nextLabel === session.label) return;
  session.label = nextLabel;
  upsertCachedSession({ sessionKey, label: nextLabel, updatedAt: Date.now() });
  renderSessions();
  if (state.currentItem === `session:${sessionKey}`) deps.updateChatHeader();
}

function createNewChatSession() {
  const sessionKey = `chat-${Date.now()}`;
  const existingSessions = Array.isArray(state.sessions) ? state.sessions : [];
  if (!existingSessions.some((item) => item?.sessionKey === sessionKey)) {
    const createdSession = { sessionKey, label: 'New Chat', updatedAt: Date.now() };
    state.sessions = [createdSession, ...existingSessions];
    upsertCachedSession(createdSession);
  }
  renderSessions();
  selectItem(`session:${sessionKey}`);
  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages) chatMessages.innerHTML = '';
  updateEmptyState();
  document.getElementById('chat-input')?.focus();
}

export function initSidebarBindings() {
  document.querySelector('.sidebar-item.pinned[data-id="openclaw"]')?.addEventListener('click', () => selectItem('openclaw'));
  document.getElementById('new-chat-btn')?.addEventListener('click', createNewChatSession);
  document.getElementById('add-project')?.addEventListener('click', () => void addProject());

  document.getElementById('project-list').addEventListener('contextmenu', (event) => {
    const projectItem = event.target.closest('[data-project-id]');
    if (!projectItem) return;
    event.preventDefault();
    window.tgclaw.showProjectContextMenu(projectItem.dataset.projectId);
  });

  window.tgclaw.onProjectDelete(({ projectId }) => deleteProject(projectId));
  window.tgclaw.onProjectRename(({ projectId }) => void renameProject(projectId));
  window.tgclaw.onSessionDelete(({ sessionKey }) => deleteSession(sessionKey));
  window.tgclaw.onSessionRename(({ sessionKey }) => void renameSession(sessionKey));
}
