import { state } from './state.js';
import { isChatItemId } from './utils.js';
import { getTerminalTheme } from './terminal-shared.js';

let resolveActiveProjectTab = () => null;

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
    tab.wrapperEl.style.display = tab.wrapperEl.classList.contains('has-split') ? 'flex' : 'block';
  }
}

export function openTerminalSearch() {
  if (isChatItemId(state.currentItem)) return;

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

export { createBaseTerminal, createTerminal } from './terminal-core.js';
