import { state } from './state.js';
import { applyTerminalTheme } from './terminal.js';

function updateThemeToggleUi(button, theme) {
  const isLight = theme === 'light';
  document.body.classList.toggle('light-theme', isLight);
  if (button) button.textContent = isLight ? '☀️' : '🌙';
}

export function initThemeToggle() {
  const button = document.getElementById('theme-toggle');
  updateThemeToggleUi(button, state.terminalTheme);

  if (!button) return;
  button.addEventListener('click', () => {
    state.terminalTheme = state.terminalTheme === 'dark' ? 'light' : 'dark';
    applyTerminalTheme(state.terminalTheme);
    updateThemeToggleUi(button, state.terminalTheme);
  });
}
