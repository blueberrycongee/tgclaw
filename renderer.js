// ── State ──
let currentItem = 'openclaw';
let projects = [];
let tabs = {};       // projectId -> [{ id, type, termId, term, cleanup }]
let activeTab = {};  // projectId -> tabId

// ── Sidebar ──
function selectItem(id) {
  currentItem = id;

  // Update sidebar active state
  document.querySelectorAll('.sidebar-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  if (id === 'openclaw') {
    document.getElementById('tabbar').style.display = 'none';
    document.getElementById('chat-panel').classList.add('active');
    hideAllTerminals();
  } else {
    document.getElementById('tabbar').style.display = 'flex';
    document.getElementById('chat-panel').classList.remove('active');
    renderTabs(id);
  }
}

async function addProject() {
  const cwd = await window.tgclaw.openDirectoryDialog();
  if (!cwd) return;

  const defaultName = cwd.split(/[\\/]/).filter(Boolean).pop() || 'Project';
  const name = prompt('Project name:', defaultName);
  if (!name) return;

  const id = 'proj-' + Date.now();
  projects.push({ id, name, cwd });
  renderProjects();
  selectItem(id);
}

function renderProjects() {
  const list = document.getElementById('project-list');
  list.innerHTML = projects
    .map(
      (p) => `
    <div class="sidebar-item ${currentItem === p.id ? 'active' : ''}" data-id="${p.id}" data-project-id="${p.id}" onclick="selectItem('${p.id}')">
      <div class="icon">📁</div>
      <div class="item-info">
        <div class="item-name">${escapeHtml(p.name)}</div>
        <div class="item-status">${escapeHtml(p.cwd)}</div>
      </div>
    </div>
  `
    )
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

  if (currentItem === projectId) {
    selectItem('openclaw');
  }

  renderProjects();
}

// ── Tabs ──
function renderTabs(projectId) {
  const projectTabs = tabs[projectId] || [];
  const active = activeTab[projectId];

  const tabList = document.getElementById('tab-list');
  tabList.innerHTML = projectTabs
    .map(
      (t) => `
    <div class="tab ${t.id === active ? 'active' : ''}" onclick="switchTab('${projectId}', '${t.id}')">
      ${agentEmoji(t.type)} ${agentLabel(t.type)}
      <span class="close-tab" onclick="event.stopPropagation(); closeTab('${projectId}', '${t.id}')">✕</span>
    </div>
  `
    )
    .join('');

  // Show/hide terminals
  hideAllTerminals();
  if (active) {
    const tab = projectTabs.find((t) => t.id === active);
    if (tab && tab.wrapperEl) {
      tab.wrapperEl.style.display = 'block';
    }
  }
}

function switchTab(projectId, tabId) {
  activeTab[projectId] = tabId;
  renderTabs(projectId);

  // Fit terminal
  const tab = (tabs[projectId] || []).find((t) => t.id === tabId);
  if (tab && tab.fitAddon) {
    setTimeout(() => tab.fitAddon.fit(), 50);
  }
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
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.open(wrapper);

  setTimeout(() => fitAddon.fit(), 100);

  // Spawn pty
  let termId;
  if (type === 'shell') {
    termId = await window.tgclaw.createPty({
      cols: term.cols,
      rows: term.rows,
      cwd: project.cwd,
    });
  } else {
    termId = await window.tgclaw.spawnAgent({
      type,
      cwd: project.cwd,
      cols: term.cols,
      rows: term.rows,
    });
  }

  // Wire up pty <-> xterm
  const cleanupData = window.tgclaw.onPtyData(termId, (data) => {
    term.write(data);
  });

  const cleanupExit = window.tgclaw.onPtyExit(termId, (code) => {
    term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
  });

  term.onData((data) => {
    window.tgclaw.writePty(termId, data);
  });

  term.onResize(({ cols, rows }) => {
    window.tgclaw.resizePty(termId, cols, rows);
  });

  const tabObj = {
    id: tabId,
    type,
    termId,
    term,
    fitAddon,
    wrapperEl: wrapper,
    cleanup: () => {
      cleanupData();
      cleanupExit();
      window.tgclaw.killPty(termId);
      term.dispose();
      wrapper.remove();
    },
  };

  tabs[project.id].push(tabObj);
  activeTab[project.id] = tabId;
  renderTabs(project.id);

  setTimeout(() => fitAddon.fit(), 150);
}

function closeTab(projectId, tabId) {
  const projectTabs = tabs[projectId] || [];
  const idx = projectTabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  projectTabs[idx].cleanup();
  projectTabs.splice(idx, 1);

  if (activeTab[projectId] === tabId) {
    activeTab[projectId] = projectTabs.length > 0 ? projectTabs[projectTabs.length - 1].id : null;
  }

  renderTabs(projectId);
}

function hideAllTerminals() {
  document.querySelectorAll('.terminal-wrapper').forEach((el) => {
    el.style.display = 'none';
  });
}

// ── Agent picker ──
function showAgentPicker() {
  document.getElementById('agent-picker').classList.add('show');
}

function hideAgentPicker() {
  document.getElementById('agent-picker').classList.remove('show');
}

document.getElementById('agent-picker').addEventListener('click', (e) => {
  if (e.target.id === 'agent-picker') hideAgentPicker();
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

// ── Chat (OpenClaw placeholder) ──
function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  appendMessage(text, 'from-user');
  input.value = '';

  // Placeholder response
  setTimeout(() => {
    appendMessage("Got it. I'll dispatch that to the right agent. Check the project tabs for progress. 🐾", 'from-bot');
  }, 500);
}

function appendMessage(text, cls) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `message ${cls}`;
  div.textContent = text;
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

// ── Resize handling ──
window.addEventListener('resize', () => {
  if (currentItem === 'openclaw') return;
  const projectTabs = tabs[currentItem] || [];
  const active = activeTab[currentItem];
  const tab = projectTabs.find((t) => t.id === active);
  if (tab && tab.fitAddon) tab.fitAddon.fit();
});
