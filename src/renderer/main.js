import './styles.css';
import './terminal-fullbleed.css';
import './chat-inputbar-flat.css';
import './tabbar-scroll.css';
import './add-tab-hover-menu.css';
import './chat-message-meta-separated.css';
import './chat-markdown-contained.css';
import { state } from './state.js';
import { copyTextToClipboard, isChatItemId, normalizeProject } from './utils.js';
import { initStaticIcons } from './icons.js';
import {
  configureSidebar,
  initSidebarBindings,
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
      if (!type || isChatItemId(state.currentItem)) return;
      void addAgentTab(type);
    });
  });
}

function bindGlobalEvents() {
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      if (!isChatItemId(state.currentItem)) {
        event.preventDefault();
        openTerminalSearch();
      }
      return;
    }

    if (event.key !== 'Escape') return;

    const picker = document.getElementById('agent-picker');
    const hoverMenu = document.getElementById('add-tab-hover-menu');
    if (picker.classList.contains('show') || hoverMenu?.classList.contains('show')) {
      hideAgentPicker();
      return;
    }

    if (state.terminalSearchVisible) {
      closeTerminalSearch();
    }
  });

  window.addEventListener('resize', () => {
    if (isChatItemId(state.currentItem)) return;
    const active = state.activeTab[state.currentItem];
    const tab = (state.tabs[state.currentItem] || []).find((item) => item.id === active);
    if (tab?.fitAddon) tab.fitAddon.fit();
  });

  window.tgclaw.onTabKill(({ projectId, tabId }) => closeTab(projectId, tabId));
  window.tgclaw.onTabRestart(async ({ projectId, tabId, tabType }) => {
    const tab = (state.tabs[projectId] || []).find((item) => item.id === tabId);
    const restartType = tabType || (tab ? tab.type : '');
    if (!restartType) return;

    closeTab(projectId, tabId);
    await addAgentTab(restartType, { projectId });
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
