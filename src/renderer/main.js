import './styles.css';
import './terminal-fullbleed.css';
import './chat-inputbar-flat.css';
import './tabbar-scroll.css';
import { state } from './state.js';
import { copyTextToClipboard, normalizeProject } from './utils.js';
import { initStaticIcons } from './icons.js';
import {
  configureSidebar,
  initSidebarBindings,
  selectItem,
  updateOpenClawBadge,
} from './sidebar.js';
import { renderProjects } from './projects.js';
import {
  addAgentTab,
  closeTab,
  configureTabs,
  getActiveProjectTab,
  getTabDisplayName,
  hideAgentPicker,
  initAgentPicker,
  switchTab,
  renderTabs,
} from './tabs.js';
import { configureChat, initChat, reloadChatHistory, updateChatHeader } from './chat.js';
import { initSettings } from './settings.js';
import { configureShortcuts, initShortcutBindings } from './shortcuts.js';
import { initThemeToggle } from './theme.js';
import {
  bindTerminalSearchEvents,
  closeTerminalSearch,
  configureTerminal,
  hideAllTerminals,
  openTerminalSearch,
} from './terminal.js';
import { exportTerminalLog, splitTerminal } from './split.js';
import { updateWindowTitle } from './title.js';

configureTerminal({ getActiveProjectTab });
configureSidebar({ renderTabs, hideAllTerminals, closeTerminalSearch, updateWindowTitle, reloadChatHistory, updateChatHeader });
configureTabs({ renderProjects, updateWindowTitle });
configureChat({ updateOpenClawBadge });
configureShortcuts({ addAgentTab, closeTab, switchTab });
initStaticIcons();

function initQuickLaunchBindings() {
  document.querySelectorAll('.quick-agent-btn[data-agent-type]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.agentType;
      if (!type || state.currentItem === 'openclaw') return;
      void addAgentTab(type);
    });
  });
}

function isChatItem(id) {
  return id === 'openclaw' || id.startsWith('session:');
}

function bindGlobalEvents() {
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      if (!isChatItem(state.currentItem)) {
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

    if (state.terminalSearchVisible) {
      closeTerminalSearch();
    }
  });

  window.addEventListener('resize', () => {
    if (isChatItem(state.currentItem)) return;
    const active = state.activeTab[state.currentItem];
    const tab = (state.tabs[state.currentItem] || []).find((item) => item.id === active);
    if (tab?.fitAddon) tab.fitAddon.fit();
  });

  window.tgclaw.onTabKill(({ projectId, tabId }) => closeTab(projectId, tabId));
  window.tgclaw.onTabRestart(async ({ projectId, tabId, tabType }) => {
    const tab = (state.tabs[projectId] || []).find((item) => item.id === tabId);
    const restartType = tabType || (tab ? tab.type : '');
    if (!restartType) return;

    if (state.currentItem !== projectId) selectItem(projectId);
    closeTab(projectId, tabId);
    await addAgentTab(restartType);
  });

  window.tgclaw.onTabCopyName(async ({ projectId, tabId, tabName }) => {
    let nextName = typeof tabName === 'string' ? tabName : '';
    if (!nextName) {
      const tab = (state.tabs[projectId] || []).find((item) => item.id === tabId);
      if (tab) nextName = getTabDisplayName(tab);
    }
    await copyTextToClipboard(nextName);
  });

  window.tgclaw.onTabExportLog(({ projectId, tabId }) => {
    const tab = (state.tabs[projectId] || []).find((item) => item.id === tabId);
    if (tab) exportTerminalLog(tab);
  });

  window.tgclaw.onTabSplit(({ projectId, tabId }) => {
    const tab = (state.tabs[projectId] || []).find((item) => item.id === tabId);
    const project = state.projects.find((item) => item.id === projectId);
    if (tab && project && !tab.splitTerminal) splitTerminal(tab, project);
  });
}

async function initProjects() {
  const savedProjects = await window.tgclaw.getProjects();
  state.projects = Array.isArray(savedProjects) ? savedProjects.map(normalizeProject).filter(Boolean) : [];
  renderProjects();
  updateOpenClawBadge();
  updateWindowTitle();
}

initSidebarBindings();
initQuickLaunchBindings();
initAgentPicker();
initShortcutBindings();
bindTerminalSearchEvents();
initChat();
initThemeToggle();
void initSettings();
bindGlobalEvents();

void initProjects();
