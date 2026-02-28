import {
  normalizeCommand,
  normalizeCommandArgs,
  normalizeTerminalSessionId,
} from './terminal-shared.js';

export async function resolveTerminalSession({
  activeSessionId,
  requestPayload,
  normalizedCommand,
  normalizedCommandArgs,
  project,
  term,
  type,
}) {
  let nextSessionId = activeSessionId;
  let sessionMeta = null;
  let spawnError = '';

  if (nextSessionId) {
    const attachResult = await window.tgclaw.attachTerminalSession({
      terminalSessionId: nextSessionId,
      cols: term.cols,
      rows: term.rows,
    });
    if (attachResult && typeof attachResult === 'object' && typeof attachResult.error === 'string') {
      spawnError = attachResult.error;
    } else {
      sessionMeta = attachResult;
      nextSessionId = normalizeTerminalSessionId(attachResult?.terminalSessionId || nextSessionId);
    }
    return { activeSessionId: nextSessionId, sessionMeta, spawnError };
  }

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
    nextSessionId = normalizeTerminalSessionId(startResult?.terminalSessionId);
    if (!nextSessionId) spawnError = 'Failed to create terminal session.';
  }

  return { activeSessionId: nextSessionId, sessionMeta, spawnError };
}
