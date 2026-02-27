import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { state } from './state.js';

let resolveActiveProjectTab = () => null;
const DARK_THEME = {
  background: '#17212b',
  foreground: '#e1e3e6',
  cursor: '#5eb5f7',
  selectionBackground: 'rgba(94,181,247,0.3)',
};
const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#0066cc',
  selectionBackground: 'rgba(0,102,204,0.2)',
};

function getTerminalTheme(theme) {
  return theme === 'light' ? LIGHT_THEME : DARK_THEME;
}

export function configureTerminal({ getActiveProjectTab }) {
  resolveActiveProjectTab = getActiveProjectTab;
}

export function hideAllTerminals() {
  document.querySelectorAll('.terminal-wrapper').forEach((el) => {
    el.style.display = 'none';
  });
}

export function showTerminal(tab) {
  if (tab?.wrapperEl) {
    tab.wrapperEl.style.display = 'block';
  }
}

export function openTerminalSearch() {
  if (state.currentItem === 'openclaw') return;

  const active = resolveActiveProjectTab();
  if (!active || !active.searchAddon) return;

  state.terminalSearchVisible = true;
  const bar = document.getElementById('terminal-search');
  const input = document.getElementById('terminal-search-input');
  bar.classList.add('show');
  input.focus();
  input.select();
}

export function closeTerminalSearch() {
  const bar = document.getElementById('terminal-search');
  if (!bar) return;

  state.terminalSearchVisible = false;
  bar.classList.remove('show');
}

export function runTerminalSearch(next = true) {
  const input = document.getElementById('terminal-search-input');
  const active = resolveActiveProjectTab();
  if (!input || !active || !active.searchAddon) return;

  const query = input.value;
  if (!query) return;

  if (next) {
    active.searchAddon.findNext(query);
    return;
  }

  active.searchAddon.findPrevious(query);
}

export function bindTerminalSearchEvents() {
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
}

export function applyTerminalTheme(theme) {
  const nextTheme = getTerminalTheme(theme);
  Object.values(state.tabs).forEach((tabs) => {
    (tabs || []).forEach((tab) => {
      if (!tab?.term) return;
      tab.term.options.theme = nextTheme;
    });
  });
}

export async function exportTerminalLog(tab) {
  if (!tab || typeof tab.getOutput !== 'function') return false;
  const raw = tab.getOutput();
  const text = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  return window.tgclaw.saveTerminalLog(text);
}

export async function createTerminal({ tabId, type, project, onExit }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper active';
  wrapper.id = `term-${tabId}`;
  document.getElementById('terminal-container').appendChild(wrapper);

  const term = new Terminal({
    theme: getTerminalTheme(state.terminalTheme),
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    cursorBlink: true,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(wrapper);
  setTimeout(() => fitAddon.fit(), 100);

  let termId = null;
  let spawnError = '';
  if (type === 'shell') {
    termId = await window.tgclaw.createPty({ cols: term.cols, rows: term.rows, cwd: project.cwd });
  } else {
    const result = await window.tgclaw.spawnAgent({ type, cwd: project.cwd, cols: term.cols, rows: term.rows });
    if (result && typeof result === 'object' && typeof result.error === 'string') {
      spawnError = result.error;
    } else {
      termId = result;
    }
  }

  if (!spawnError && (termId === null || termId === undefined)) {
    spawnError = 'Failed to spawn process.';
  }

  let cleanupData = () => {};
  let cleanupExit = () => {};
  const outputBuffer = [];
  if (!spawnError) {
    cleanupData = window.tgclaw.onPtyData(termId, (data) => {
      outputBuffer.push(data);
      term.write(data);
    });
    cleanupExit = window.tgclaw.onPtyExit(termId, (code) => {
      term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
      window.tgclaw.notifyProcessExit({ agentType: type, projectName: project.name, exitCode: code });
      onExit(code);
    });
    term.onData((data) => window.tgclaw.writePty(termId, data));
    term.onResize(({ cols, rows }) => window.tgclaw.resizePty(termId, cols, rows));
  } else {
    term.write(`\r\n\x1b[31m${spawnError}\x1b[0m\r\n`);
    onExit(1);
  }

  return {
    termId,
    term,
    fitAddon,
    searchAddon,
    exited: Boolean(spawnError),
    wrapperEl: wrapper,
    getOutput: () => outputBuffer.join(''),
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
}
