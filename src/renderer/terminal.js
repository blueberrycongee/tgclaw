import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { state } from './state.js';

let resolveActiveProjectTab = () => null;
const DARK_THEME = { background: '#000000', foreground: '#fafafa', cursor: '#0070f3', selectionBackground: 'rgba(0,112,243,0.25)' };
const LIGHT_THEME = { background: '#ffffff', foreground: '#171717', cursor: '#0070f3', selectionBackground: 'rgba(0,112,243,0.15)' };
function getTerminalTheme(theme) { return theme === 'light' ? LIGHT_THEME : DARK_THEME; }
export function configureTerminal({ getActiveProjectTab }) { resolveActiveProjectTab = getActiveProjectTab; }

export function hideAllTerminals() {
  document.querySelectorAll('.terminal-wrapper').forEach((el) => { el.style.display = 'none'; });
}

export function showTerminal(tab) {
  if (tab?.wrapperEl) tab.wrapperEl.style.display = tab.wrapperEl.classList.contains('has-split') ? 'flex' : 'block';
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

export function createBaseTerminal() {
  return new Terminal({ theme: getTerminalTheme(state.terminalTheme), fontSize: 13, fontFamily: 'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", "Oxygen Mono", "Ubuntu Monospace", "Source Code Pro", "Fira Mono", "Droid Sans Mono", "Courier New", monospace', cursorBlink: true, allowProposedApi: true });
}

export async function createTerminal({ tabId, type, project, onExit, onRestart, onOutput }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper active';
  wrapper.id = `term-${tabId}`;
  document.getElementById('terminal-container').appendChild(wrapper);

  const term = createBaseTerminal();

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
    const result = await window.tgclaw.createPty({ cols: term.cols, rows: term.rows, cwd: project.cwd });
    if (result && typeof result === 'object' && typeof result.error === 'string') {
      spawnError = result.error;
    } else {
      termId = result;
    }
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
  let cleanupInput = () => {};
  let cleanupResize = () => {};
  let cleanupRestart = () => {};
  let lastActivityAt = Date.now();
  const outputBuffer = [];
  if (!spawnError) {
    cleanupData = window.tgclaw.onPtyData(termId, (data) => {
      lastActivityAt = Date.now();
      outputBuffer.push(data);
      term.write(data);
      if (typeof onOutput === 'function') onOutput();
    });
    cleanupExit = window.tgclaw.onPtyExit(termId, (code) => {
      cleanupInput();
      term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
      term.write('\r\n\x1b[36mPress Enter to restart...\x1b[0m\r\n');
      const restartDisposable = term.onData((data) => {
        if (data === '\r' || data === '\n') {
          cleanupRestart();
          if (typeof onRestart === 'function') onRestart();
        }
      });
      cleanupRestart = () => restartDisposable.dispose();
      window.tgclaw.notifyProcessExit({ agentType: type, projectName: project.name, exitCode: code });
      onExit(code);
    });
    const inputDisposable = term.onData((data) => {
      lastActivityAt = Date.now();
      window.tgclaw.writePty(termId, data);
    });
    cleanupInput = () => inputDisposable.dispose();
    const resizeDisposable = term.onResize(({ cols, rows }) => window.tgclaw.resizePty(termId, cols, rows));
    cleanupResize = () => resizeDisposable.dispose();
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
    lastActivityAt,
    wrapperEl: wrapper,
    getOutput: () => outputBuffer.join(''),
    getLastActivityAt: () => lastActivityAt,
    cleanup: () => {
      cleanupData();
      cleanupExit();
      cleanupInput();
      cleanupResize();
      cleanupRestart();
      if (typeof termId === 'number') {
        window.tgclaw.killPty(termId);
      }
      term.dispose();
      wrapper.remove();
    },
  };
}
