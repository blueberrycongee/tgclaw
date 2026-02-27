// ── State ──
let currentItem = 'openclaw';
let projects = [];
let tabs = {};       // projectId -> [{ id, type, termId, term, exited, cleanup }]
let activeTab = {};  // projectId -> tabId
let agentPickerSelectionLocked = false;
let dragTabState = { projectId: null, tabId: null };
let dragProjectState = { projectId: null };
let tabRenameState = { projectId: null, tabId: null };
let terminalSearchVisible = false;
let unreadCount = 0;

// ── Sidebar ──
function normalizeProject(project) {
  if (!project || typeof project !== 'object') return null;
  if (typeof project.id !== 'string' || typeof project.name !== 'string' || typeof project.cwd !== 'string') {
    return null;
  }
  return { id: project.id, name: project.name, cwd: project.cwd };
}

async function persistProjects() {
  await window.tgclaw.saveProjects(projects);
}

function selectItem(id) {
  currentItem = id;

  // Update sidebar active state
  document.querySelectorAll('.sidebar-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  if (id === 'openclaw') {
    unreadCount = 0;
    updateOpenClawBadge();
    document.getElementById('tabbar').style.display = 'none';
    document.getElementById('chat-panel').classList.add('active');
    closeTerminalSearch();
    hideAllTerminals();
  } else {
    document.getElementById('tabbar').style.display = 'flex';
    document.getElementById('chat-panel').classList.remove('active');
    renderTabs(id);
  }

  updateWindowTitle();
}

async function addProject() {
  const cwd = await window.tgclaw.openDirectoryDialog();
  if (!cwd) return;

  const defaultName = cwd.split(/[\\/]/).filter(Boolean).pop() || 'Project';
  const name = prompt('Project name:', defaultName);
  if (!name) return;

  const id = 'proj-' + Date.now();
  projects.push({ id, name, cwd });
  await persistProjects();
  renderProjects();
  selectItem(id);
}

function renderProjects() {
  const list = document.getElementById('project-list');
  list.innerHTML = projects
    .map((p) => {
      const activeCount = (tabs[p.id] || []).filter((tab) => !tab.exited).length;
      return `
    <div
      class="sidebar-item ${currentItem === p.id ? 'active' : ''}"
      data-id="${p.id}"
      data-project-id="${p.id}"
      draggable="true"
      onclick="selectItem('${p.id}')"
      ondragstart="onProjectDragStart(event, '${p.id}')"
      ondragover="onProjectDragOver(event, '${p.id}')"
      ondrop="onProjectDrop(event, '${p.id}')"
      ondragend="onProjectDragEnd()"
    >
      <div class="icon">📁</div>
      <div class="item-info">
        <div class="item-name-row">
          <div class="item-name">${escapeHtml(p.name)}</div>
          ${activeCount > 0 ? `<span class="item-badge">${activeCount}</span>` : ''}
        </div>
        <div class="item-status">${escapeHtml(p.cwd)}</div>
      </div>
    </div>
  `
    })
    .join('');
}

function deleteProject(projectId) {
  const index = projects.findIndex((p) => p.id === projectId);
  if (index === -1) return;

  const projectTabs = tabs[projectId] || [];
  projectTabs.forEach((tab) => tab.cleanup());

  delete tabs[projectId];
  delete activeTab[projectId];
  projects.splice(index, 1);
  void persistProjects();

  if (currentItem === projectId) {
    selectItem('openclaw');
  }

  renderProjects();
}

function clearProjectDropIndicators() {
  document.querySelectorAll('.sidebar-item[data-project-id]').forEach((itemEl) => {
    itemEl.classList.remove('drag-over-before', 'drag-over-after');
  });
}

function onProjectDragStart(event, projectId) {
  dragProjectState = { projectId };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', projectId);
  event.currentTarget.classList.add('dragging');
}

function onProjectDragOver(event, targetProjectId) {
  if (!dragProjectState.projectId || dragProjectState.projectId === targetProjectId) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';

  clearProjectDropIndicators();

  const rect = event.currentTarget.getBoundingClientRect();
  const dropAfter = event.clientY > rect.top + rect.height / 2;
  event.currentTarget.classList.add(dropAfter ? 'drag-over-after' : 'drag-over-before');
}

async function onProjectDrop(event, targetProjectId) {
  event.preventDefault();

  const sourceProjectId = dragProjectState.projectId;
  if (!sourceProjectId || sourceProjectId === targetProjectId) {
    onProjectDragEnd();
    return;
  }

  const sourceIndex = projects.findIndex((project) => project.id === sourceProjectId);
  const targetIndex = projects.findIndex((project) => project.id === targetProjectId);
  if (sourceIndex === -1 || targetIndex === -1) {
    onProjectDragEnd();
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  const dropAfter = event.clientY > rect.top + rect.height / 2;
  let nextIndex = targetIndex + (dropAfter ? 1 : 0);
  if (sourceIndex < nextIndex) nextIndex -= 1;

  const [movedProject] = projects.splice(sourceIndex, 1);
  projects.splice(nextIndex, 0, movedProject);

  onProjectDragEnd();
  renderProjects();
  await persistProjects();
}

function onProjectDragEnd() {
  dragProjectState = { projectId: null };
  document.querySelectorAll('.sidebar-item[data-project-id]').forEach((itemEl) => {
    itemEl.classList.remove('dragging');
  });
  clearProjectDropIndicators();
}

// ── Tabs ──
function getTabDisplayName(tab) {
  return tab.customName || `${agentEmoji(tab.type)} ${agentLabel(tab.type)}`;
}

function isTabRenaming(projectId, tabId) {
  return tabRenameState.projectId === projectId && tabRenameState.tabId === tabId;
}

function onTabTitleDoubleClick(event, projectId, tabId) {
  event.stopPropagation();
  tabRenameState = { projectId, tabId };
  renderTabs(projectId);
}

function finishTabRename(projectId, tabId, inputValue) {
  if (!isTabRenaming(projectId, tabId)) return;

  const projectTabs = tabs[projectId] || [];
  const tab = projectTabs.find((t) => t.id === tabId);
  if (tab) {
    tab.customName = String(inputValue || '').trim();
  }

  tabRenameState = { projectId: null, tabId: null };
  renderTabs(projectId);
  updateWindowTitle();
}

function onTabRenameKeydown(event, projectId, tabId) {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    finishTabRename(projectId, tabId, event.currentTarget.value);
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    tabRenameState = { projectId: null, tabId: null };
    renderTabs(projectId);
  }
}

function renderTabs(projectId) {
  const projectTabs = tabs[projectId] || [];
  const active = activeTab[projectId];

  const tabList = document.getElementById('tab-list');
  tabList.innerHTML = projectTabs
    .map((t) => {
      const titleMarkup = isTabRenaming(projectId, t.id)
        ? `
      <input
        class="tab-rename-input"
        type="text"
        value="${escapeHtml(getTabDisplayName(t))}"
        data-tab-id="${t.id}"
        onclick="event.stopPropagation()"
        ondblclick="event.stopPropagation()"
        onkeydown="onTabRenameKeydown(event, '${projectId}', '${t.id}')"
        onblur="finishTabRename('${projectId}', '${t.id}', this.value)"
      />
    `
        : `<span class="tab-title" ondblclick="onTabTitleDoubleClick(event, '${projectId}', '${t.id}')">${escapeHtml(getTabDisplayName(t))}</span>`;

      return `
    <div
      class="tab ${t.id === active ? 'active' : ''}"
      draggable="true"
      onclick="switchTab('${projectId}', '${t.id}')"
      oncontextmenu="onTabContextMenu(event, '${projectId}', '${t.id}')"
      ondragstart="onTabDragStart(event, '${projectId}', '${t.id}')"
      ondragover="onTabDragOver(event, '${projectId}', '${t.id}')"
      ondrop="onTabDrop(event, '${projectId}', '${t.id}')"
      ondragend="onTabDragEnd()"
    >
      ${titleMarkup}
      ${t.exited ? '<span class="tab-exited-flag">[Exited]</span>' : ''}
      <span class="close-tab" onclick="event.stopPropagation(); closeTab('${projectId}', '${t.id}')">✕</span>
    </div>
  `
    })
    .join('');

  if (tabRenameState.projectId === projectId && tabRenameState.tabId) {
    const input = tabList.querySelector(`.tab-rename-input[data-tab-id="${tabRenameState.tabId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }

  // Show/hide terminals
  hideAllTerminals();
  if (active) {
    const tab = projectTabs.find((t) => t.id === active);
    if (tab && tab.wrapperEl) {
      tab.wrapperEl.style.display = 'block';
    }
  } else if (terminalSearchVisible) {
    closeTerminalSearch();
  }
}

function switchTab(projectId, tabId) {
  activeTab[projectId] = tabId;
  renderTabs(projectId);
  updateWindowTitle();

  // Fit terminal
  const tab = (tabs[projectId] || []).find((t) => t.id === tabId);
  if (tab && tab.fitAddon) {
    setTimeout(() => tab.fitAddon.fit(), 50);
  }
}

function onTabContextMenu(event, projectId, tabId) {
  event.preventDefault();

  const projectTabs = tabs[projectId] || [];
  const tab = projectTabs.find((item) => item.id === tabId);
  if (!tab) return;

  window.tgclaw.showTabContextMenu({
    projectId,
    tabId,
    tabType: tab.type,
    tabName: getTabDisplayName(tab),
  });
}

function getActiveProjectTab(projectId = currentItem) {
  const projectTabs = tabs[projectId] || [];
  const active = activeTab[projectId];
  return projectTabs.find((tab) => tab.id === active) || null;
}

function openTerminalSearch() {
  if (currentItem === 'openclaw') return;

  const active = getActiveProjectTab();
  if (!active || !active.searchAddon) return;

  const bar = document.getElementById('terminal-search');
  const input = document.getElementById('terminal-search-input');

  terminalSearchVisible = true;
  bar.classList.add('show');
  input.focus();
  input.select();
}

function closeTerminalSearch() {
  const bar = document.getElementById('terminal-search');
  if (!bar) return;

  terminalSearchVisible = false;
  bar.classList.remove('show');
}

function runTerminalSearch(next = true) {
  const input = document.getElementById('terminal-search-input');
  const active = getActiveProjectTab();
  if (!input || !active || !active.searchAddon) return;

  const query = input.value;
  if (!query) return;

  if (next) {
    active.searchAddon.findNext(query);
    return;
  }

  active.searchAddon.findPrevious(query);
}

async function addAgentTab(type) {
  hideAgentPicker();

  const project = projects.find((p) => p.id === currentItem);
  if (!project) return;

  const tabId = 'tab-' + Date.now();

  if (!tabs[project.id]) tabs[project.id] = [];

  // Create terminal wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper active';
  wrapper.id = `term-${tabId}`;
  document.getElementById('terminal-container').appendChild(wrapper);

  // Create xterm instance
  const term = new Terminal({
    theme: {
      background: '#17212b',
      foreground: '#e1e3e6',
      cursor: '#5eb5f7',
      selectionBackground: '#2b5278',
      black: '#0e1621',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#5eb5f7',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#e1e3e6',
    },
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    cursorBlink: true,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  const searchAddon = new SearchAddon.SearchAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(webLinksAddon);
  term.open(wrapper);

  setTimeout(() => fitAddon.fit(), 100);

  // Spawn pty
  let termId = null;
  let spawnError = '';
  if (type === 'shell') {
    termId = await window.tgclaw.createPty({
      cols: term.cols,
      rows: term.rows,
      cwd: project.cwd,
    });
  } else {
    const spawnResult = await window.tgclaw.spawnAgent({
      type,
      cwd: project.cwd,
      cols: term.cols,
      rows: term.rows,
    });
    if (spawnResult && typeof spawnResult === 'object' && typeof spawnResult.error === 'string') {
      spawnError = spawnResult.error;
    } else {
      termId = spawnResult;
    }
  }

  if (!spawnError && (termId === null || termId === undefined)) {
    spawnError = 'Failed to spawn process.';
  }

  // Wire up pty <-> xterm
  let tabObj = null;
  let cleanupData = () => {};
  let cleanupExit = () => {};

  if (!spawnError) {
    cleanupData = window.tgclaw.onPtyData(termId, (data) => {
      term.write(data);
    });

    cleanupExit = window.tgclaw.onPtyExit(termId, (code) => {
      term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
      window.tgclaw.notifyProcessExit({
        agentType: type,
        projectName: project.name,
        exitCode: code,
      });
      if (!tabObj) return;
      tabObj.exited = true;
      renderProjects();
      if (currentItem === project.id) {
        renderTabs(project.id);
      }
    });

    term.onData((data) => {
      window.tgclaw.writePty(termId, data);
    });

    term.onResize(({ cols, rows }) => {
      window.tgclaw.resizePty(termId, cols, rows);
    });
  } else {
    term.write(`\r\n\x1b[31m${spawnError}\x1b[0m\r\n`);
  }

  tabObj = {
    id: tabId,
    type,
    customName: '',
    termId,
    term,
    fitAddon,
    searchAddon,
    exited: Boolean(spawnError),
    wrapperEl: wrapper,
    cleanup: () => {
      cleanupData();
      cleanupExit();
      if (termId !== null && termId !== undefined) {
        window.tgclaw.killPty(termId);
      }
      term.dispose();
      wrapper.remove();
    },
  };

  tabs[project.id].push(tabObj);
  activeTab[project.id] = tabId;
  renderTabs(project.id);
  renderProjects();
  updateWindowTitle();

  setTimeout(() => fitAddon.fit(), 150);
}

function closeTab(projectId, tabId) {
  const projectTabs = tabs[projectId] || [];
  const idx = projectTabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  if (isTabRenaming(projectId, tabId)) {
    tabRenameState = { projectId: null, tabId: null };
  }

  projectTabs[idx].cleanup();
  projectTabs.splice(idx, 1);

  if (activeTab[projectId] === tabId) {
    activeTab[projectId] = projectTabs.length > 0 ? projectTabs[projectTabs.length - 1].id : null;
  }

  renderTabs(projectId);
  renderProjects();
  updateWindowTitle();
}

function createShellTabFromShortcut() {
  if (currentItem === 'openclaw') return;
  addAgentTab('shell');
}

function closeActiveTabFromShortcut() {
  if (currentItem === 'openclaw') return;
  const currentTabId = activeTab[currentItem];
  if (!currentTabId) return;
  closeTab(currentItem, currentTabId);
}

function switchTabByIndexFromShortcut(index) {
  if (currentItem === 'openclaw') return;
  const projectTabs = tabs[currentItem] || [];
  const targetTab = projectTabs[index];
  if (!targetTab) return;
  switchTab(currentItem, targetTab.id);
}

function clearTabDropIndicators() {
  document.querySelectorAll('.tab').forEach((tabEl) => {
    tabEl.classList.remove('drag-over-before', 'drag-over-after');
  });
}

function onTabDragStart(event, projectId, tabId) {
  if (isTabRenaming(projectId, tabId)) {
    event.preventDefault();
    return;
  }

  dragTabState = { projectId, tabId };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', tabId);
  event.currentTarget.classList.add('dragging');
}

function onTabDragOver(event, projectId, targetTabId) {
  if (dragTabState.projectId !== projectId) return;
  if (dragTabState.tabId === targetTabId) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';

  clearTabDropIndicators();

  const rect = event.currentTarget.getBoundingClientRect();
  const dropAfter = event.clientX > rect.left + rect.width / 2;
  event.currentTarget.classList.add(dropAfter ? 'drag-over-after' : 'drag-over-before');
}

function onTabDrop(event, projectId, targetTabId) {
  event.preventDefault();

  if (dragTabState.projectId !== projectId) {
    onTabDragEnd();
    return;
  }

  const projectTabs = tabs[projectId] || [];
  const sourceIndex = projectTabs.findIndex((tab) => tab.id === dragTabState.tabId);
  const targetIndex = projectTabs.findIndex((tab) => tab.id === targetTabId);

  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
    onTabDragEnd();
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  const dropAfter = event.clientX > rect.left + rect.width / 2;
  let nextIndex = targetIndex + (dropAfter ? 1 : 0);
  if (sourceIndex < nextIndex) nextIndex -= 1;

  const [movedTab] = projectTabs.splice(sourceIndex, 1);
  projectTabs.splice(nextIndex, 0, movedTab);

  onTabDragEnd();
  renderTabs(projectId);
}

function onTabDragEnd() {
  dragTabState = { projectId: null, tabId: null };
  document.querySelectorAll('.tab').forEach((tabEl) => {
    tabEl.classList.remove('dragging');
  });
  clearTabDropIndicators();
}

function hideAllTerminals() {
  document.querySelectorAll('.terminal-wrapper').forEach((el) => {
    el.style.display = 'none';
  });
}

// ── Agent picker ──
function showAgentPicker() {
  agentPickerSelectionLocked = false;
  document.getElementById('agent-picker').classList.add('show');
}

function hideAgentPicker() {
  agentPickerSelectionLocked = false;
  document.getElementById('agent-picker').classList.remove('show');
}

document.getElementById('agent-picker').addEventListener('click', (e) => {
  if (e.target.id === 'agent-picker') hideAgentPicker();
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    if (currentItem !== 'openclaw') {
      event.preventDefault();
      openTerminalSearch();
    }
    return;
  }

  if (event.key !== 'Escape') return;

  const picker = document.getElementById('agent-picker');
  if (picker.classList.contains('show')) {
    hideAgentPicker();
    return;
  }

  if (terminalSearchVisible) {
    closeTerminalSearch();
  }
});

const terminalSearchInput = document.getElementById('terminal-search-input');
const terminalSearchPrev = document.getElementById('terminal-search-prev');
const terminalSearchNext = document.getElementById('terminal-search-next');
const terminalSearchClose = document.getElementById('terminal-search-close');

terminalSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runTerminalSearch(!event.shiftKey);
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    closeTerminalSearch();
  }
});

terminalSearchPrev.addEventListener('click', () => runTerminalSearch(false));
terminalSearchNext.addEventListener('click', () => runTerminalSearch(true));
terminalSearchClose.addEventListener('click', () => closeTerminalSearch());

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

document.getElementById('project-list').addEventListener('contextmenu', (event) => {
  const projectItem = event.target.closest('[data-project-id]');
  if (!projectItem) return;

  event.preventDefault();
  window.tgclaw.showProjectContextMenu(projectItem.dataset.projectId);
});

window.tgclaw.onProjectDelete(({ projectId }) => {
  deleteProject(projectId);
});

window.tgclaw.onProjectRename(async ({ projectId }) => {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;

  const input = prompt('Rename project:', project.name);
  if (input === null) return;

  const nextName = input.trim();
  if (!nextName || nextName === project.name) return;

  project.name = nextName;
  await persistProjects();
  renderProjects();
});

window.tgclaw.onAppShortcut(({ action, index }) => {
  if (action === 'new-shell-tab') {
    createShellTabFromShortcut();
    return;
  }

  if (action === 'close-current-tab') {
    closeActiveTabFromShortcut();
    return;
  }

  if (action === 'switch-tab' && Number.isInteger(index)) {
    switchTabByIndexFromShortcut(index);
  }
});

window.tgclaw.onTabKill(({ projectId, tabId }) => {
  closeTab(projectId, tabId);
});

window.tgclaw.onTabRestart(async ({ projectId, tabId, tabType }) => {
  const projectTabs = tabs[projectId] || [];
  const tab = projectTabs.find((item) => item.id === tabId);
  const restartType = tabType || (tab ? tab.type : '');
  if (!restartType) return;

  if (currentItem !== projectId) {
    selectItem(projectId);
  }

  closeTab(projectId, tabId);
  await addAgentTab(restartType);
});

window.tgclaw.onTabCopyName(async ({ projectId, tabId, tabName }) => {
  let nextName = typeof tabName === 'string' ? tabName : '';

  if (!nextName) {
    const projectTabs = tabs[projectId] || [];
    const tab = projectTabs.find((item) => item.id === tabId);
    if (tab) {
      nextName = getTabDisplayName(tab);
    }
  }

  await copyTextToClipboard(nextName);
});

// ── Chat (OpenClaw placeholder) ──
const chatInput = document.getElementById('chat-input');

function resizeChatInput() {
  chatInput.style.height = 'auto';
  const nextHeight = Math.min(chatInput.scrollHeight, 120);
  chatInput.style.height = `${nextHeight}px`;
  chatInput.style.overflowY = chatInput.scrollHeight > 120 ? 'auto' : 'hidden';
}

chatInput.addEventListener('input', resizeChatInput);
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChat();
  }
});

resizeChatInput();

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;

  appendMessage(text, 'from-user');
  chatInput.value = '';
  resizeChatInput();

  // Placeholder response
  setTimeout(() => {
    appendMessage("Got it. I'll dispatch that to the right agent. Check the project tabs for progress. 🐾", 'from-bot');
  }, 500);
}

function appendMessage(text, cls) {
  if (cls === 'from-bot' && currentItem !== 'openclaw') {
    unreadCount += 1;
    updateOpenClawBadge();
  }

  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `message ${cls}`;
  if (cls === 'from-bot' && window.marked?.parse) {
    div.innerHTML = window.marked.parse(text);
  } else {
    div.textContent = text;
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ── Helpers ──
function agentEmoji(type) {
  const map = { 'claude-code': '🟠', codex: '🟢', goose: '🦆', aider: '🔵', shell: '⬛' };
  return map[type] || '⚪';
}

function agentLabel(type) {
  const map = { 'claude-code': 'Claude Code', codex: 'Codex', goose: 'Goose', aider: 'Aider', shell: 'Shell' };
  return map[type] || type;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function updateOpenClawBadge() {
  const badge = document.getElementById('openclaw-badge');
  if (!badge) return;

  if (unreadCount > 0) {
    badge.textContent = String(unreadCount);
    badge.style.display = 'inline-flex';
    return;
  }

  badge.textContent = '';
  badge.style.display = 'none';
}

function updateWindowTitle() {
  let title = 'TGClaw — OpenClaw';

  if (currentItem !== 'openclaw') {
    const project = projects.find((item) => item.id === currentItem);
    const active = getActiveProjectTab(currentItem);
    const projectName = project ? project.name : 'Unknown Project';
    const tabName = active ? getTabDisplayName(active) : 'No Tab';
    title = `TGClaw — ${projectName} — ${tabName}`;
  }

  window.tgclaw.setWindowTitle(title);
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return;

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      // Fall back to execCommand below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

// ── Resize handling ──
window.addEventListener('resize', () => {
  if (currentItem === 'openclaw') return;
  const projectTabs = tabs[currentItem] || [];
  const active = activeTab[currentItem];
  const tab = projectTabs.find((t) => t.id === active);
  if (tab && tab.fitAddon) tab.fitAddon.fit();
});

async function initProjects() {
  const savedProjects = await window.tgclaw.getProjects();
  projects = Array.isArray(savedProjects)
    ? savedProjects.map(normalizeProject).filter(Boolean)
    : [];
  renderProjects();
  updateOpenClawBadge();
  updateWindowTitle();
}

void initProjects();
