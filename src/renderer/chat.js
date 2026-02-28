import { animateMessageEntry, appendMessage, configureChatMessages, scrollChatToBottom, updateEmptyState } from './chat-messages.js';
import { state } from './state.js';
import { gateway } from './gateway.js';
import { appendCachedMessage, getCachedMessages } from './chat-cache.js';
import { clearAllCliLaunchState, handleGatewayEventFrame } from './chat-terminal.js';
import { clearHistoryRecoveryTimer, clearPendingChatRequest, configureChatHistory, hydrateChatFromCache, reloadChatHistory, sessionLabelForKey, setPendingChatRequest, startHistoryRecoveryLoop } from './chat-history.js';
import { configureChatStream, formatGatewayErrorMessage, getCurrentRunId, getCurrentRunKey, getIsStreaming, getStreamRuns, handleGatewayChat, setCurrentRunId, setCurrentRunKey, setIsStreaming } from './chat-stream.js';
const INITIAL_RESPONSE_TIMEOUT_MS = 12000;
const STREAM_IDLE_TIMEOUT_MS = 18000;
const DEFAULT_MAIN_SESSION_KEY = 'main';
let chatInput = null;
let assistantPending = false;
let assistantStalled = false;
let gatewayOnline = false;
let gatewayMainSessionKey = DEFAULT_MAIN_SESSION_KEY;
let gatewayMainKey = DEFAULT_MAIN_SESSION_KEY;
let gatewayDefaultAgentId = '';
let chatHeaderStatus = null;
let chatHeaderStatusText = null;
let typingIndicatorDiv = null;
let pendingTimeoutHandle = null;
let streamIdleTimeoutHandle = null;
let lastAssistantActivityAt = 0;
export function configureChat({ updateOpenClawBadge }) { configureChatMessages({ updateOpenClawBadge }); }
function normalizeSessionKeyForGateway(sessionKey) {
  const key = typeof sessionKey === 'string' && sessionKey.trim() ? sessionKey.trim() : 'default';
  const mainSessionKey = gatewayMainSessionKey || DEFAULT_MAIN_SESSION_KEY;
  const mainKey = gatewayMainKey || DEFAULT_MAIN_SESSION_KEY;
  if (key === 'default' || key === DEFAULT_MAIN_SESSION_KEY || key === mainKey || key === mainSessionKey) return mainSessionKey;
  if (gatewayDefaultAgentId && [`agent:${gatewayDefaultAgentId}:main`, `agent:${gatewayDefaultAgentId}:${mainKey}`].includes(key)) return mainSessionKey;
  return key;
}
function applyGatewaySessionDefaults(helloPayload) {
  const defaults = helloPayload?.snapshot?.sessionDefaults;
  gatewayMainSessionKey = typeof defaults?.mainSessionKey === 'string' && defaults.mainSessionKey.trim() ? defaults.mainSessionKey.trim() : DEFAULT_MAIN_SESSION_KEY;
  gatewayMainKey = typeof defaults?.mainKey === 'string' && defaults.mainKey.trim() ? defaults.mainKey.trim() : DEFAULT_MAIN_SESSION_KEY;
  gatewayDefaultAgentId = typeof defaults?.defaultAgentId === 'string' ? defaults.defaultAgentId.trim() : '';
}
function normalizeAssistantMessage(message, options = {}) {
  if (!message || typeof message !== 'object') return null;
  const roleValue = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  if (options.requireRole === true && roleValue !== 'assistant') return null;
  if (roleValue && roleValue !== 'assistant') return null;
  if (!('content' in message) && !('text' in message)) return null;
  return message;
}
function shouldReloadHistoryForFinalFrame(frame) {
  if (frame?.state !== 'final') return false;
  const role = typeof frame?.message?.role === 'string' ? frame.message.role.toLowerCase() : '';
  return !frame?.message || typeof frame.message !== 'object' || Boolean(role && role !== 'assistant');
}
export function updateChatHeader() {
  const title = document.querySelector('.chat-header-title');
  if (!title) return;
  if (!state.currentSessionKey || state.currentSessionKey === 'default') { title.textContent = 'OpenClaw'; return; }
  const session = (Array.isArray(state.sessions) ? state.sessions : []).find((item) => item && item.sessionKey === state.currentSessionKey);
  title.textContent = typeof session?.label === 'string' && session.label.trim() ? session.label : state.currentSessionKey;
}
function resizeChatInput() {
  if (!chatInput) return;
  chatInput.style.height = 'auto';
  const nextHeight = Math.min(chatInput.scrollHeight, 120);
  chatInput.style.height = `${nextHeight}px`;
  chatInput.style.overflowY = chatInput.scrollHeight > 120 ? 'auto' : 'hidden';
}
function clearTypingIndicator() { if (typingIndicatorDiv) { typingIndicatorDiv.remove(); typingIndicatorDiv = null; updateEmptyState(); } }
function showTypingIndicator() {
  clearTypingIndicator();
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'message-row from-bot typing-row';
  const div = document.createElement('div');
  div.className = 'message from-bot typing-indicator';
  div.innerHTML = '<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>';
  row.appendChild(div);
  container.appendChild(row);
  typingIndicatorDiv = row;
  animateMessageEntry(row);
  updateEmptyState();
  scrollChatToBottom();
}
function clearPendingTimeout() { if (pendingTimeoutHandle) { clearTimeout(pendingTimeoutHandle); pendingTimeoutHandle = null; } }
function clearStreamIdleTimeout() { if (streamIdleTimeoutHandle) { clearTimeout(streamIdleTimeoutHandle); streamIdleTimeoutHandle = null; } }
function clearAssistantWatchdogs() { clearPendingTimeout(); clearStreamIdleTimeout(); clearHistoryRecoveryTimer(); }
function scheduleStreamIdleTimeout() {
  clearStreamIdleTimeout();
  if (!assistantPending && !getIsStreaming()) return;
  streamIdleTimeoutHandle = setTimeout(() => {
    if (!assistantPending && !getIsStreaming()) return;
    if (Date.now() - lastAssistantActivityAt < STREAM_IDLE_TIMEOUT_MS - 50) { scheduleStreamIdleTimeout(); return; }
    assistantStalled = true;
    clearTypingIndicator();
    renderChatHeaderStatus();
  }, STREAM_IDLE_TIMEOUT_MS);
}
function touchAssistantActivity() { lastAssistantActivityAt = Date.now(); if (assistantStalled) assistantStalled = false; clearPendingTimeout(); scheduleStreamIdleTimeout(); }
function armInitialResponseTimeout() {
  clearPendingTimeout();
  pendingTimeoutHandle = setTimeout(() => {
    if (!assistantPending || getIsStreaming() || getStreamRuns().size > 0) return;
    assistantStalled = true;
    clearTypingIndicator();
    renderChatHeaderStatus();
  }, INITIAL_RESPONSE_TIMEOUT_MS);
}
function beginAssistantPending() {
  const sessionKey = state.currentSessionKey || 'default';
  const assistantCountAtSend = getCachedMessages(sessionKey).filter((message) => message?.role === 'assistant').length;
  setPendingChatRequest({ sessionKey, startedAt: Date.now(), assistantCountAtSend }); assistantPending = true; assistantStalled = false;
  showTypingIndicator();
  touchAssistantActivity();
  armInitialResponseTimeout();
  startHistoryRecoveryLoop();
}
function showStopButton() { const btn = document.getElementById('chat-stop'); if (btn) btn.style.display = 'inline-flex'; }
function hideStopButton() { const btn = document.getElementById('chat-stop'); if (btn) btn.style.display = 'none'; }
function abortChat() {
  if (!getIsStreaming() || !getCurrentRunId()) return;
  void gateway.chatAbort(normalizeSessionKeyForGateway(state.currentSessionKey), getCurrentRunId()).catch(() => {});
}
function activeRunEntriesForSession(sessionKey) {
  const key = normalizeSessionKeyForGateway(sessionKey || 'default');
  return Array.from(getStreamRuns().entries()).filter(([, run]) => normalizeSessionKeyForGateway(run.sessionKey) === key);
}
function syncStreamingUiState() {
  const activeRuns = activeRunEntriesForSession(state.currentSessionKey);
  setIsStreaming(activeRuns.length > 0);
  if (getIsStreaming()) showStopButton(); else hideStopButton();
  const runKey = getCurrentRunKey();
  if (runKey && getStreamRuns().has(runKey)) setCurrentRunId(getStreamRuns().get(runKey).runId || getCurrentRunId());
  else if (activeRuns.length > 0) {
    const [latestRunKey, latestRun] = activeRuns[activeRuns.length - 1];
    setCurrentRunKey(latestRunKey);
    setCurrentRunId(latestRun.runId || getCurrentRunId());
  } else { setCurrentRunKey(''); setCurrentRunId(null); }
  if (!assistantPending && !getIsStreaming()) { assistantStalled = false; clearAssistantWatchdogs(); clearPendingChatRequest(); }
  renderChatHeaderStatus();
}
function renderChatHeaderStatus() {
  if (!chatHeaderStatus || !chatHeaderStatusText) return;
  chatHeaderStatus.classList.remove('is-online', 'is-offline', 'is-connecting', 'is-typing', 'is-waiting');
  if (!gatewayOnline) { chatHeaderStatus.classList.add('is-offline'); chatHeaderStatusText.textContent = 'Offline'; return; }
  if (assistantPending || getIsStreaming()) {
    if (assistantStalled) { chatHeaderStatus.classList.add('is-waiting'); chatHeaderStatusText.textContent = 'Waiting...'; return; }
    chatHeaderStatus.classList.add('is-typing'); chatHeaderStatusText.textContent = 'Typing...'; return;
  }
  chatHeaderStatus.classList.add('is-online'); chatHeaderStatusText.textContent = 'Online';
}
function resetStreamingState() {
  clearTypingIndicator();
  clearAssistantWatchdogs();
  clearAllCliLaunchState();
  getStreamRuns().forEach((run) => { if (run.contentDiv?.parentElement) run.contentDiv.parentElement.classList.remove('is-streaming'); });
  getStreamRuns().clear();
  setCurrentRunId(null); setCurrentRunKey(''); setIsStreaming(false); assistantPending = false; assistantStalled = false;
  clearPendingChatRequest();
  hideStopButton();
  renderChatHeaderStatus();
}
export function sendChat() {
  const text = chatInput?.value.trim();
  if (!text) return;
  const createdAt = Date.now();
  appendMessage(text, 'from-user', { createdAt });
  appendCachedMessage(state.currentSessionKey, { role: 'user', content: text, createdAt }, { label: sessionLabelForKey(state.currentSessionKey), touchSession: state.currentSessionKey !== 'default' });
  chatInput.value = '';
  resizeChatInput();
  if (!gateway.connected) { appendMessage('Not connected to OpenClaw. Open Gateway Settings to configure.', 'from-bot'); return; }
  beginAssistantPending();
  renderChatHeaderStatus();
  void gateway.chatSend(normalizeSessionKeyForGateway(state.currentSessionKey), text).catch((err) => { resetStreamingState(); appendMessage(`Gateway error: ${formatGatewayErrorMessage(err?.message || 'Failed to send message')}`, 'from-bot message-error'); });
}
export function initChat() {
  chatInput = document.getElementById('chat-input');
  chatHeaderStatus = document.querySelector('.chat-header-status');
  chatHeaderStatusText = document.getElementById('chat-status-text');
  configureChatHistory({ normalizeSessionKeyForGateway, resetStreamingState, isAssistantPending: () => assistantPending, setAssistantPending: (value) => { assistantPending = Boolean(value); }, isStreaming: () => getIsStreaming(), setAssistantStalled: (value) => { assistantStalled = Boolean(value); }, clearTypingIndicator, syncStreamingUiState });
  configureChatStream({ normalizeSessionKeyForGateway, normalizeAssistantMessage, shouldReloadHistoryForFinalFrame, clearTypingIndicator, touchAssistantActivity, isAssistantPending: () => assistantPending, setAssistantPending: (value) => { assistantPending = Boolean(value); }, syncStreamingUiState });
  document.getElementById('chat-send')?.addEventListener('click', sendChat);
  document.getElementById('chat-stop')?.addEventListener('click', abortChat);
  chatInput.addEventListener('input', resizeChatInput);
  chatInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat(); } });
  gateway.on('chat', handleGatewayChat);
  gateway.on('event', handleGatewayEventFrame);
  gateway.on('connected', (helloPayload) => { applyGatewaySessionDefaults(helloPayload); gatewayOnline = true; renderChatHeaderStatus(); void reloadChatHistory(); });
  gateway.on('disconnected', () => { gatewayOnline = false; resetStreamingState(); });
  gateway.on('error', () => { gatewayOnline = false; resetStreamingState(); });
  gatewayOnline = gateway.connected;
  renderChatHeaderStatus();
  updateChatHeader();
  updateEmptyState();
  resizeChatInput();
  void hydrateChatFromCache();
}
