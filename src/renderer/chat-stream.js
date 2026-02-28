import { renderBotMessage } from './markdown.js';
import { addCodeBlockCopyButtons, appendMessage, createStreamMessage, notifyIncomingBotMessage, scrollChatToBottom } from './chat-messages.js';
import { state } from './state.js';
import { appendCachedMessage } from './chat-cache.js';
import { captureExternalExecutionEvidence } from './chat-external-exec.js';
import { ENABLE_CHAT_TEXT_COMMAND_FALLBACK, clearCliLaunchStateByRun, spawnCliFromGatewayFrame } from './chat-terminal.js';
import { reloadChatHistory, sessionLabelForKey } from './chat-history.js';
const streamRuns = new Map();
let currentRunId = null; let currentRunKey = ''; let isStreaming = false;
const hooks = {
  normalizeSessionKeyForGateway: (sessionKey) => sessionKey || 'default',
  normalizeAssistantMessage: (message) => message,
  shouldReloadHistoryForFinalFrame: () => false,
  clearTypingIndicator: () => {},
  touchAssistantActivity: () => {},
  isAssistantPending: () => false,
  setAssistantPending: () => {},
  syncStreamingUiState: () => {},
};
export function configureChatStream(nextHooks = {}) { Object.assign(hooks, nextHooks); }
export function getStreamRuns() { return streamRuns; }
export function getCurrentRunId() { return currentRunId; } export function setCurrentRunId(value) { currentRunId = value; }
export function getCurrentRunKey() { return currentRunKey; } export function setCurrentRunKey(value) { currentRunKey = value; }
export function getIsStreaming() { return isStreaming; } export function setIsStreaming(value) { isStreaming = Boolean(value); }
function extractMessageContent(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('');
  return '';
}
function extractFrameText(frame) {
  const fields = [frame?.delta, frame?.final, frame?.content, frame?.text];
  const direct = fields.find((item) => typeof item === 'string');
  return direct || extractMessageContent(frame?.message);
}
function longestSuffixPrefixOverlap(left, right) {
  const maxLength = Math.min(left.length, right.length);
  for (let size = maxLength; size > 0; size -= 1) if (left.slice(-size) === right.slice(0, size)) return size;
  return 0;
}
function mergeIncomingText(currentText, incomingText) {
  if (!incomingText) return currentText;
  if (!currentText || incomingText === currentText) return incomingText || currentText;
  if (incomingText.startsWith(currentText)) return incomingText;
  if (currentText.startsWith(incomingText)) return currentText;
  const overlap = longestSuffixPrefixOverlap(currentText, incomingText);
  if (overlap > 0) return currentText + incomingText.slice(overlap);
  if (incomingText.length > currentText.length + 12) return incomingText;
  return `${currentText}${incomingText}`;
}
function resolveMessageRow(messageElement) {
  if (!messageElement) return null;
  const parent = messageElement.parentElement;
  return parent?.classList.contains('message-row') ? parent : messageElement;
}
function mergeStreamText(currentText, frame) {
  let merged = currentText;
  const directDelta = typeof frame?.delta === 'string' ? frame.delta : '';
  if (directDelta) merged = mergeIncomingText(merged, directDelta);
  [extractMessageContent(frame?.message), typeof frame?.content === 'string' ? frame.content : '', typeof frame?.text === 'string' ? frame.text : ''].filter(Boolean).forEach((snapshot) => {
    merged = mergeIncomingText(merged, snapshot);
  });
  return merged;
}
function extractFrameRunId(frame) {
  if (typeof frame?.runId === 'string' && frame.runId.trim()) return frame.runId.trim();
  if (typeof frame?.run?.id === 'string' && frame.run.id.trim()) return frame.run.id.trim();
  return '';
}
function extractFrameSessionKey(frame) {
  const keys = [frame?.sessionKey, frame?.session?.sessionKey, frame?.session?.key, frame?.session];
  const sessionKey = keys.find((item) => typeof item === 'string' && item.trim());
  const rawSessionKey = typeof sessionKey === 'string' ? sessionKey.trim() : (state.currentSessionKey || 'default');
  return hooks.normalizeSessionKeyForGateway(rawSessionKey);
}
function streamRunKey(frame) {
  const sessionKey = extractFrameSessionKey(frame);
  const runId = extractFrameRunId(frame);
  return runId ? { key: `${sessionKey}:${runId}`, sessionKey, runId } : { key: `${sessionKey}:anonymous`, sessionKey, runId: '' };
}
function queueStreamRender(run) {
  if (!run?.contentDiv || run.renderQueued) return;
  run.renderQueued = true;
  requestAnimationFrame(() => {
    run.renderQueued = false;
    if (!run.contentDiv) return;
    run.contentDiv.textContent = run.text;
    scrollChatToBottom();
  });
}
function formatGatewayErrorMessage(rawMessage) {
  const message = typeof rawMessage === 'string' && rawMessage.trim() ? rawMessage.trim() : 'Unknown error';
  const normalized = message.toLowerCase();
  const looksLikeRelayHeaderMismatch = normalized.includes('temporarily overloaded') || normalized.includes('upstream service unavailable');
  if (!looksLikeRelayHeaderMismatch) return message;
  return `${message} Hint: if Claude Code works with the same relay, check OpenClaw provider headers/auth mode (Bearer auth + Claude CLI headers).`;
}
function handleGatewayChat(frame) {
  captureExternalExecutionEvidence(frame);
  const eventState = typeof frame?.state === 'string' ? frame.state : '';
  const { key: runKey, sessionKey: frameSessionKey, runId: frameRunId } = streamRunKey(frame);
  const currentSessionKey = hooks.normalizeSessionKeyForGateway(state.currentSessionKey || 'default');
  const isCurrentSessionFrame = frameSessionKey === currentSessionKey;
  const runLookupKey = `${frameSessionKey}:${frameRunId || 'anonymous'}`;
  if (ENABLE_CHAT_TEXT_COMMAND_FALLBACK && eventState === 'final') void spawnCliFromGatewayFrame(frame, runLookupKey);
  if (isCurrentSessionFrame) {
    hooks.touchAssistantActivity();
    if (hooks.isAssistantPending()) hooks.setAssistantPending(false);
  }
  if (eventState === 'delta') {
    const delta = extractFrameText(frame);
    if (!delta) return;
    let run = streamRuns.get(runKey);
    if (!run) {
      if (!isCurrentSessionFrame) return;
      hooks.clearTypingIndicator();
      const contentDiv = createStreamMessage();
      if (contentDiv?.parentElement) contentDiv.parentElement.classList.add('is-streaming');
      run = { key: runKey, runId: frameRunId, sessionKey: frameSessionKey, text: '', startedAt: Date.now(), contentDiv, renderQueued: false };
      streamRuns.set(runKey, run);
    } else if (frameRunId && !run.runId) run.runId = frameRunId;
    if (isCurrentSessionFrame) {
      run.text = mergeStreamText(run.text, frame);
      queueStreamRender(run);
      currentRunKey = runKey;
      if (run.runId) currentRunId = run.runId;
      hooks.syncStreamingUiState();
    }
    return;
  }
  if (eventState === 'final') {
    const run = streamRuns.get(runKey);
    const finalMessage = hooks.normalizeAssistantMessage(frame?.message, { requireRole: false });
    const finalText = extractFrameText(frame) || extractMessageContent(finalMessage) || run?.text || '';
    if (run?.contentDiv && isCurrentSessionFrame) {
      const runMessage = run.contentDiv.parentElement;
      const runRow = resolveMessageRow(runMessage);
      if (runMessage) runMessage.classList.remove('is-streaming');
      if (finalText) {
        renderBotMessage(run.contentDiv, finalText);
        addCodeBlockCopyButtons(run.contentDiv);
        scrollChatToBottom();
      } else if (runRow) runRow.remove();
    } else if (finalText && isCurrentSessionFrame) appendMessage(finalText, 'from-bot', { createdAt: Date.now() });
    if (finalText) {
      const cacheSessionKey = isCurrentSessionFrame ? (state.currentSessionKey || 'default') : frameSessionKey;
      appendCachedMessage(cacheSessionKey, { role: 'assistant', content: finalText, createdAt: run?.startedAt || Date.now() }, { label: sessionLabelForKey(cacheSessionKey), touchSession: cacheSessionKey !== 'default' });
    }
    if (finalText && isCurrentSessionFrame) notifyIncomingBotMessage(finalText);
    if (!finalText && isCurrentSessionFrame && hooks.shouldReloadHistoryForFinalFrame(frame)) void reloadChatHistory();
    if (run) {
      if (run.contentDiv?.parentElement) run.contentDiv.parentElement.classList.remove('is-streaming');
      streamRuns.delete(runKey);
    }
    clearCliLaunchStateByRun(runLookupKey);
    if (currentRunKey === runKey) currentRunKey = '';
    hooks.syncStreamingUiState();
    return;
  }
  if (eventState === 'aborted') {
    const run = streamRuns.get(runKey);
    const normalizedMessage = hooks.normalizeAssistantMessage(frame?.message, { requireRole: true });
    const abortedText = extractMessageContent(normalizedMessage) || extractFrameText(frame) || run?.text || '';
    if (run?.contentDiv && isCurrentSessionFrame) {
      const runMessage = run.contentDiv.parentElement;
      const runRow = resolveMessageRow(runMessage);
      if (runMessage) runMessage.classList.remove('is-streaming');
      if (abortedText) {
        renderBotMessage(run.contentDiv, abortedText);
        addCodeBlockCopyButtons(run.contentDiv);
        scrollChatToBottom();
      } else if (runRow) runRow.remove();
    } else if (abortedText && isCurrentSessionFrame) appendMessage(abortedText, 'from-bot', { createdAt: Date.now() });
    if (abortedText) {
      const cacheSessionKey = isCurrentSessionFrame ? (state.currentSessionKey || 'default') : frameSessionKey;
      appendCachedMessage(cacheSessionKey, { role: 'assistant', content: abortedText, createdAt: run?.startedAt || Date.now() }, { label: sessionLabelForKey(cacheSessionKey), touchSession: cacheSessionKey !== 'default' });
    }
    if (run?.contentDiv?.parentElement) run.contentDiv.parentElement.classList.remove('is-streaming');
    streamRuns.delete(runKey);
    clearCliLaunchStateByRun(runLookupKey);
    if (currentRunKey === runKey) currentRunKey = '';
    hooks.syncStreamingUiState();
    return;
  }
  if (eventState === 'error') {
    const rawMessage = frame?.error?.message || frame?.errorMessage || extractFrameText(frame);
    const message = formatGatewayErrorMessage(rawMessage);
    const run = streamRuns.get(runKey);
    if (run?.contentDiv?.parentElement) run.contentDiv.parentElement.classList.remove('is-streaming');
    streamRuns.delete(runKey);
    clearCliLaunchStateByRun(runLookupKey);
    if (currentRunKey === runKey) currentRunKey = '';
    if (isCurrentSessionFrame) appendMessage(`Gateway error: ${message}`, 'from-bot message-error');
    hooks.syncStreamingUiState();
  }
}
export { extractMessageContent, extractFrameText, longestSuffixPrefixOverlap, mergeIncomingText, resolveMessageRow, mergeStreamText, extractFrameRunId, extractFrameSessionKey, streamRunKey, queueStreamRender, formatGatewayErrorMessage, handleGatewayChat };
