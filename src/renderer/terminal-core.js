import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { state } from './state.js';
import {
  formatCommandLabel,
  getTerminalTheme,
  normalizeCommand,
  normalizeCommandArgs,
  normalizeTerminalSessionId,
} from './terminal-shared.js';
import { resolveTerminalSession } from './terminal-session.js';
import { bindTerminalRuntime, hydrateCapturedExecution } from './terminal-runtime.js';

export function createBaseTerminal() {
  return new Terminal({
    theme: getTerminalTheme(state.terminalTheme),
    fontSize: 13,
    fontFamily: 'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", "Oxygen Mono", "Ubuntu Monospace", "Source Code Pro", "Fira Mono", "Droid Sans Mono", "Courier New", monospace',
    cursorBlink: true,
    allowProposedApi: true,
  });
}

export async function createTerminal({
  tabId,
  type,
  command,
  commandArgs = [],
  captureExecution = null,
  project,
  visible = true,
  terminalSessionId = '',
  terminalRequest = null,
  keepAliveOnCleanup = false,
  onExit,
  onRestart,
  onOutput,
}) {
  const wrapper = document.createElement('div');
  wrapper.className = visible ? 'terminal-wrapper active' : 'terminal-wrapper';
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
  let activeSessionId = normalizeTerminalSessionId(terminalSessionId);
  let sessionMeta = null;
  const isCapturedExecution = !!(captureExecution && typeof captureExecution === 'object');
  const normalizedCommand = normalizeCommand(command);
  const normalizedCommandArgs = normalizeCommandArgs(commandArgs);
  const label = formatCommandLabel(normalizedCommand || type, normalizedCommandArgs) || type || 'shell';
  const requestPayload = terminalRequest && typeof terminalRequest === 'object' ? terminalRequest : {};

  const sessionResult = await resolveTerminalSession({
    activeSessionId,
    requestPayload,
    normalizedCommand,
    normalizedCommandArgs,
    project,
    term,
    type,
  });
  activeSessionId = sessionResult.activeSessionId;
  sessionMeta = sessionResult.sessionMeta;
  const spawnError = sessionResult.spawnError;

  const outputBuffer = [];
  let lastActivityAt = Date.now();
  let getLastActivityAt = () => lastActivityAt;
  let cleanupRuntime = () => {};

  if (isCapturedExecution) {
    const captured = hydrateCapturedExecution({
      captureExecution,
      activeSessionId,
      label,
      project,
      term,
      outputBuffer,
      onOutput,
    });
    activeSessionId = captured.activeSessionId;
    lastActivityAt = captured.lastActivityAt;
  } else if (!spawnError) {
    const runtime = bindTerminalRuntime({
      activeSessionId,
      sessionMeta,
      label,
      type,
      project,
      term,
      outputBuffer,
      onOutput,
      onRestart,
      onExit,
    });
    cleanupRuntime = runtime.cleanup;
    getLastActivityAt = runtime.getLastActivityAt;
    lastActivityAt = runtime.getLastActivityAt();
  } else {
    term.write(`\r\n\x1b[31m${spawnError}\x1b[0m\r\n`);
    if (typeof onExit === 'function') onExit(1);
  }

  return {
    termId,
    terminalSessionId: activeSessionId,
    pid: isCapturedExecution && Number.isInteger(captureExecution.pid)
      ? captureExecution.pid
      : (sessionMeta?.pid ?? null),
    sessionMeta,
    term,
    fitAddon,
    searchAddon,
    exited: isCapturedExecution ? captureExecution.exited === true : Boolean(spawnError),
    lastActivityAt,
    wrapperEl: wrapper,
    getOutput: () => outputBuffer.join(''),
    getLastActivityAt: () => getLastActivityAt(),
    cleanup: () => {
      cleanupRuntime();
      if (!isCapturedExecution && !keepAliveOnCleanup && activeSessionId) {
        window.tgclaw.killTerminalSession(activeSessionId);
      } else if (!isCapturedExecution && !keepAliveOnCleanup && typeof termId === 'number') {
        window.tgclaw.killPty(termId);
      }
      term.dispose();
      wrapper.remove();
    },
  };
}
