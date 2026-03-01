import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { state } from './state.js';
import { isChatItemId } from './utils.js';

let resolveActiveProjectTab = () => null;
const DARK_THEME = { background: '#000000', foreground: '#fafafa', cursor: '#0070f3', selectionBackground: 'rgba(0,112,243,0.25)' };
const LIGHT_THEME = { background: '#ffffff', foreground: '#171717', cursor: '#0070f3', selectionBackground: 'rgba(0,112,243,0.15)' };
function getTerminalTheme(theme) { return theme === 'light' ? LIGHT_THEME : DARK_THEME; }
export function configureTerminal({ getActiveProjectTab }) { resolveActiveProjectTab = getActiveProjectTab; }

function normalizeCommand(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeCommandArgs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item == null) return '';
      return String(item);
    })
    .filter(Boolean);
}

function formatCommandLabel(command, commandArgs) {
  const normalizedCommand = normalizeCommand(command);
  const args = normalizeCommandArgs(commandArgs);
  if (!normalizedCommand) return '';
  return args.length > 0 ? `${normalizedCommand} ${args.join(' ')}` : normalizedCommand;
}

function normalizeTerminalSessionId(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function hideAllTerminals() {
  document.querySelectorAll('.terminal-wrapper').forEach((el) => { el.style.display = 'none'; });
}

export function showTerminal(tab) {
  if (tab?.wrapperEl) tab.wrapperEl.style.display = tab.wrapperEl.classList.contains('has-split') ? 'flex' : 'block';
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

export function createBaseTerminal() {
  return new Terminal({ theme: getTerminalTheme(state.terminalTheme), fontSize: 13, fontFamily: 'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", "Oxygen Mono", "Ubuntu Monospace", "Source Code Pro", "Fira Mono", "Droid Sans Mono", "Courier New", monospace', cursorBlink: true, allowProposedApi: true });
}

export async function createVirtualTerminal({
  tabId,
  project,
  visible = true,
  terminalSessionId = '',
  onExit,
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

  let lastActivityAt = Date.now();
  const outputBuffer = [];
  let exited = false;
  const normalizedSessionId = normalizeTerminalSessionId(terminalSessionId);

  function appendOutput(text) {
    if (typeof text !== 'string' || !text) return;
    lastActivityAt = Date.now();
    outputBuffer.push(text);
    term.write(text);
    if (typeof onOutput === 'function') onOutput();
  }

  function markExited(code = 0) {
    exited = true;
    if (typeof onExit === 'function') onExit(code);
  }

  return {
    termId: null,
    terminalSessionId: normalizedSessionId,
    pid: null,
    sessionMeta: null,
    term,
    fitAddon,
    searchAddon,
    exited,
    lastActivityAt,
    wrapperEl: wrapper,
    appendOutput,
    markExited,
    getOutput: () => outputBuffer.join(''),
    getLastActivityAt: () => lastActivityAt,
    cleanup: () => {
      term.dispose();
      wrapper.remove();
    },
  };
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
  let spawnError = '';
  const requestPayload = terminalRequest && typeof terminalRequest === 'object' ? terminalRequest : {};

  if (activeSessionId) {
    const attachResult = await window.tgclaw.attachTerminalSession({
      terminalSessionId: activeSessionId,
      cols: term.cols,
      rows: term.rows,
    });
    if (attachResult && typeof attachResult === 'object' && typeof attachResult.error === 'string') {
      spawnError = attachResult.error;
    } else {
      sessionMeta = attachResult;
      activeSessionId = normalizeTerminalSessionId(attachResult?.terminalSessionId || activeSessionId);
    }
  } else {
    const requestArgs = normalizeCommandArgs(requestPayload.args);
    const requestCommand = normalizeCommand(requestPayload.command);
    const startResult = await window.tgclaw.startTerminalSession({
      requestId: normalizeCommand(requestPayload.requestId),
      runId: normalizeCommand(requestPayload.runId),
      projectId: normalizeCommand(requestPayload.projectId) || project.id,
      cwd: normalizeCommand(requestPayload.cwd) || project.cwd,
      command: requestCommand || normalizedCommand,
      args: requestArgs.length > 0 ? requestArgs : normalizedCommandArgs,
      type: requestCommand || normalizedCommand ? '' : type,
      env: requestPayload.env && typeof requestPayload.env === 'object' ? requestPayload.env : {},
      cols: Number.isFinite(requestPayload.cols) ? requestPayload.cols : term.cols,
      rows: Number.isFinite(requestPayload.rows) ? requestPayload.rows : term.rows,
      titleHint: normalizeCommand(requestPayload.titleHint),
      initialInput: typeof requestPayload.initialInput === 'string' ? requestPayload.initialInput : '',
    });
    if (startResult && typeof startResult === 'object' && typeof startResult.error === 'string') {
      spawnError = startResult.error;
    } else {
      sessionMeta = startResult;
      activeSessionId = normalizeTerminalSessionId(startResult?.terminalSessionId);
      if (!activeSessionId) spawnError = 'Failed to create terminal session.';
    }
  }

  let cleanupData = () => {};
  let cleanupExit = () => {};
  let cleanupInput = () => {};
  let cleanupResize = () => {};
  let cleanupRestart = () => {};
  let lastActivityAt = Date.now();
  const outputBuffer = [];
  if (isCapturedExecution) {
    const capturedSessionId = normalizeTerminalSessionId(captureExecution.sessionId);
    const captureId = normalizeTerminalSessionId(captureExecution.captureId)
      || (capturedSessionId ? `external:${capturedSessionId}` : normalizeTerminalSessionId(activeSessionId));
    activeSessionId = captureId || activeSessionId;
    const captureCommand = formatCommandLabel(captureExecution.command, captureExecution.args);
    const captureStatus = normalizeCommand(captureExecution.status) || 'running';
    const captureLines = [
      '\x1b[36m[Captured external execution]\x1b[0m',
      `Command: ${captureCommand || label}`,
      `Project: ${project.cwd}`,
      `Workdir: ${normalizeCommand(captureExecution.cwd) || project.cwd}`,
      capturedSessionId ? `Session: ${capturedSessionId}` : '',
      Number.isInteger(captureExecution.pid) ? `PID: ${captureExecution.pid}` : '',
      `Status: ${captureStatus}`,
      '',
    ].filter(Boolean);
    const captureHeader = `${captureLines.join('\r\n')}\r\n`;
    outputBuffer.push(captureHeader);
    term.write(captureHeader);
    if (typeof captureExecution.output === 'string' && captureExecution.output.trim()) {
      const body = `${captureExecution.output.trimEnd()}\r\n`;
      outputBuffer.push(body);
      term.write(body);
    }
    if (typeof onOutput === 'function') onOutput();
  } else if (!spawnError) {
    cleanupData = window.tgclaw.onTerminalSessionData(activeSessionId, (data) => {
      lastActivityAt = Date.now();
      outputBuffer.push(data);
      term.write(data);
      if (typeof onOutput === 'function') onOutput();
    });
    cleanupExit = window.tgclaw.onTerminalSessionExit(activeSessionId, (payload) => {
      const code = Number.isInteger(payload?.exitCode)
        ? payload.exitCode
        : (Number.isInteger(payload) ? payload : 0);
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
      const sessionLabel = formatCommandLabel(sessionMeta?.command, sessionMeta?.args);
      window.tgclaw.notifyProcessExit({
        agentType: sessionLabel || label || type,
        projectName: project.name,
        exitCode: code,
      });
      if (typeof onExit === 'function') onExit(code);
    });
    const inputDisposable = term.onData((data) => {
      lastActivityAt = Date.now();
      window.tgclaw.writeTerminalSession(activeSessionId, data);
    });
    cleanupInput = () => inputDisposable.dispose();
    const resizeDisposable = term.onResize(({ cols, rows }) => window.tgclaw.resizeTerminalSession(activeSessionId, cols, rows));
    cleanupResize = () => resizeDisposable.dispose();

    const recentOutput = typeof sessionMeta?.recentOutput === 'string' ? sessionMeta.recentOutput : '';
    if (recentOutput) {
      outputBuffer.push(recentOutput);
      term.write(recentOutput);
      if (typeof onOutput === 'function') onOutput();
    }
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
    getLastActivityAt: () => lastActivityAt,
    cleanup: () => {
      cleanupData();
      cleanupExit();
      cleanupInput();
    cleanupResize();
    cleanupRestart();
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
