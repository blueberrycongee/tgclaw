import './styles.css';
import { state } from './state.js';
import { copyTextToClipboard, normalizeProject } from './utils.js';
import {
  configureSidebar,
  initSidebarBindings,
  renderProjects,
  selectItem,
  updateOpenClawBadge,
} from './sidebar.js';
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
import { configureChat, initChat } from './chat.js';
import { configureShortcuts, initShortcutBindings } from './shortcuts.js';
import {
  bindTerminalSearchEvents,
  closeTerminalSearch,
  configureTerminal,
  hideAllTerminals,
  openTerminalSearch,
} from './terminal.js';
import { updateWindowTitle } from './title.js';

configureTerminal({ getActiveProjectTab });
configureSidebar({ renderTabs, hideAllTerminals, closeTerminalSearch, updateWindowTitle });
configureTabs({ renderProjects, updateWindowTitle });
configureChat({ updateOpenClawBadge });
configureShortcuts({ addAgentTab, closeTab, switchTab });

function bindGlobalEvents() {
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      if (state.currentItem !== 'openclaw') {
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
    if (state.currentItem === 'openclaw') return;
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
}

async function initProjects() {
  const savedProjects = await window.tgclaw.getProjects();
  state.projects = Array.isArray(savedProjects) ? savedProjects.map(normalizeProject).filter(Boolean) : [];
  renderProjects();
  updateOpenClawBadge();
  updateWindowTitle();
}

initSidebarBindings();
initAgentPicker();
initShortcutBindings();
bindTerminalSearchEvents();
initChat();
bindGlobalEvents();

void initProjects();
