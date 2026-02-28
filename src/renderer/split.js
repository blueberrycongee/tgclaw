import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { createBaseTerminal } from './terminal.js';

export async function exportTerminalLog(tab) {
  if (!tab || typeof tab.getOutput !== 'function') return false;
  const raw = tab.getOutput();
  const text = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  return window.tgclaw.saveTerminalLog(text);
}

export async function splitTerminal(tab, project) {
  if (!tab?.wrapperEl || !project || tab.splitTerminal) return null;

  const wrapper = tab.wrapperEl;
  const primaryPane = document.createElement('div');
  primaryPane.className = 'terminal-split-pane';
  while (wrapper.firstChild) primaryPane.appendChild(wrapper.firstChild);
  wrapper.appendChild(primaryPane);

  const divider = document.createElement('div');
  divider.className = 'split-divider';
  wrapper.appendChild(divider);

  const secondaryPane = document.createElement('div');
  secondaryPane.className = 'terminal-split-pane';
  wrapper.appendChild(secondaryPane);
  wrapper.classList.add('has-split', 'terminal-split-pane');

  const term = createBaseTerminal();
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(secondaryPane);

  const outputBuffer = [];
  const spawnResult = await window.tgclaw.createPty({ cols: term.cols, rows: term.rows, cwd: project.cwd });
  const termId = (spawnResult && typeof spawnResult === 'object' && typeof spawnResult.error === 'string')
    ? null
    : spawnResult;
  let cleanupData = () => {};
  let cleanupExit = () => {};
  if (typeof termId === 'number') {
    cleanupData = window.tgclaw.onPtyData(termId, (data) => {
      outputBuffer.push(data);
      term.write(data);
    });
    cleanupExit = window.tgclaw.onPtyExit(termId, (code) => {
      term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
    });
    term.onData((data) => window.tgclaw.writePty(termId, data));
    term.onResize(({ cols, rows }) => window.tgclaw.resizePty(termId, cols, rows));
  } else {
    const message = spawnResult && typeof spawnResult === 'object' && typeof spawnResult.error === 'string'
      ? spawnResult.error
      : 'Failed to spawn process.';
    term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
  }

  tab.splitTerminal = {
    termId,
    term,
    fitAddon,
    wrapperEl: secondaryPane,
    outputBuffer,
    getOutput: () => outputBuffer.join(''),
    cleanup: () => {
      cleanupData();
      cleanupExit();
      if (typeof termId === 'number') window.tgclaw.killPty(termId);
      term.dispose();
      secondaryPane.remove();
      divider.remove();
      while (primaryPane.firstChild) wrapper.appendChild(primaryPane.firstChild);
      primaryPane.remove();
      wrapper.classList.remove('has-split', 'terminal-split-pane');
      delete tab.splitTerminal;
      tab.fitAddon?.fit();
    },
  };

  setTimeout(() => {
    tab.fitAddon?.fit();
    fitAddon.fit();
  }, 100);

  return tab.splitTerminal;
}
