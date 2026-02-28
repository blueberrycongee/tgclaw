import {
  formatCommandLabel,
  normalizeCommand,
  normalizeTerminalSessionId,
} from './terminal-shared.js';

export function hydrateCapturedExecution({
  captureExecution,
  activeSessionId,
  label,
  project,
  term,
  outputBuffer,
  onOutput,
}) {
  const capturedSessionId = normalizeTerminalSessionId(captureExecution.sessionId);
  const captureId = normalizeTerminalSessionId(captureExecution.captureId)
    || (capturedSessionId ? `external:${capturedSessionId}` : normalizeTerminalSessionId(activeSessionId));
  const nextSessionId = captureId || activeSessionId;
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
  return { activeSessionId: nextSessionId, lastActivityAt: Date.now() };
}

export function bindTerminalRuntime({
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
}) {
  let cleanupData = () => {};
  let cleanupExit = () => {};
  let cleanupInput = () => {};
  let cleanupResize = () => {};
  let cleanupRestart = () => {};
  let lastActivityAt = Date.now();

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

  const resizeDisposable = term.onResize(({ cols, rows }) => {
    window.tgclaw.resizeTerminalSession(activeSessionId, cols, rows);
  });
  cleanupResize = () => resizeDisposable.dispose();

  const recentOutput = typeof sessionMeta?.recentOutput === 'string' ? sessionMeta.recentOutput : '';
  if (recentOutput) {
    outputBuffer.push(recentOutput);
    term.write(recentOutput);
    if (typeof onOutput === 'function') onOutput();
  }

  return {
    cleanup: () => {
      cleanupData();
      cleanupExit();
      cleanupInput();
      cleanupResize();
      cleanupRestart();
    },
    getLastActivityAt: () => lastActivityAt,
  };
}
