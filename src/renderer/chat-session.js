const HISTORY_RECOVERY_POLL_MS = 3000;
const HISTORY_RECOVERY_STALE_MS = 90000;
export function createChatSession(deps) {
  const {
    state,
    gateway,
    renderSessions,
    selectItem,
    appendMessage,
    ensureChatCacheLoaded,
    getCachedMessages,
    getCachedSessions,
    setCachedMessages,
    updateEmptyState,
    scrollChatToBottom,
    clearTypingIndicator,
    syncStreamingUiState,
    resetStreamingState,
    defaultMainSessionKey,
    getAssistantPending,
    setAssistantPending,
    getIsStreaming,
    setAssistantStalled,
    getPendingChatRequest,
    setPendingChatRequest,
  } = deps;
  let gatewayMainSessionKey = defaultMainSessionKey;
  let gatewayMainKey = defaultMainSessionKey;
  let gatewayDefaultAgentId = '';
  let historyRecoveryTimer = null;
  let historyRecoveryInFlight = false;
  function normalizeSessionKeyForGateway(sessionKey) {
    const key = typeof sessionKey === 'string' && sessionKey.trim() ? sessionKey.trim() : 'default';
    const mainSessionKey = gatewayMainSessionKey || defaultMainSessionKey;
    const mainKey = gatewayMainKey || defaultMainSessionKey;
    if (key === 'default' || key === defaultMainSessionKey || key === mainKey || key === mainSessionKey) return mainSessionKey;
    if (gatewayDefaultAgentId) {
      const aliases = [`agent:${gatewayDefaultAgentId}:main`, `agent:${gatewayDefaultAgentId}:${mainKey}`];
      if (aliases.includes(key)) return mainSessionKey;
    }
    return key;
  }
  function applyGatewaySessionDefaults(helloPayload) {
    const defaults = helloPayload?.snapshot?.sessionDefaults;
    gatewayMainSessionKey = typeof defaults?.mainSessionKey === 'string' && defaults.mainSessionKey.trim()
      ? defaults.mainSessionKey.trim()
      : defaultMainSessionKey;
    gatewayMainKey = typeof defaults?.mainKey === 'string' && defaults.mainKey.trim()
      ? defaults.mainKey.trim()
      : defaultMainSessionKey;
    gatewayDefaultAgentId = typeof defaults?.defaultAgentId === 'string' ? defaults.defaultAgentId.trim() : '';
  }
  function clearHistoryRecoveryTimer() {
    if (!historyRecoveryTimer) return;
    clearInterval(historyRecoveryTimer);
    historyRecoveryTimer = null;
  }
  function sessionLabelForKey(sessionKey) {
    if (!sessionKey || sessionKey === 'default') return 'OpenClaw';
    const session = (Array.isArray(state.sessions) ? state.sessions : []).find((item) => item?.sessionKey === sessionKey);
    return typeof session?.label === 'string' && session.label.trim() ? session.label.trim() : sessionKey;
  }
  function normalizeHistoryMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const content = typeof message.content === 'string' ? message.content : (typeof message.text === 'string' ? message.text : '');
    if (!content.trim()) return null;
    const role = message.role === 'assistant' || message.role === 'bot' ? 'assistant' : 'user';
    const timestamp = new Date(message.createdAt ?? message.ts ?? message.timestamp ?? Date.now()).getTime();
    const createdAt = Number.isFinite(timestamp) ? timestamp : Date.now();
    const id = typeof message.id === 'string' && message.id ? message.id : `${role}-${createdAt}-${Math.random().toString(16).slice(2, 8)}`;
    return { id, role, content, createdAt };
  }
  function mergeHistoryMessages(localMessages, remoteMessages) {
    const all = [...localMessages, ...remoteMessages].map(normalizeHistoryMessage).filter(Boolean).sort((left, right) => left.createdAt - right.createdAt);
    const merged = [];
    const seenIds = new Set();
    all.forEach((message) => {
      if (seenIds.has(message.id)) return;
      seenIds.add(message.id);
      const previous = merged[merged.length - 1];
      if (previous && previous.role === message.role && previous.content === message.content) return;
      merged.push(message);
    });
    return merged;
  }
  function renderHistoryMessages(messages) {
    messages.forEach((message) => {
      if (message.role === 'user') {
        appendMessage(message.content, 'from-user', { animate: false, createdAt: message.createdAt });
        return;
      }
      appendMessage(message.content, 'from-bot', { animate: false, createdAt: message.createdAt });
    });
  }
  async function reloadChatHistory() {
    await ensureChatCacheLoaded();
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const sessionKey = state.currentSessionKey || 'default';
    const remoteSessionKey = normalizeSessionKeyForGateway(sessionKey);
    resetStreamingState();
    container.innerHTML = '';
    const localMessages = getCachedMessages(sessionKey);
    if (localMessages.length) renderHistoryMessages(localMessages);
    updateEmptyState();
    if (!gateway.connected) return;
    try {
      const remotePayload = await gateway.chatHistory(remoteSessionKey, 50);
      const remoteMessages = Array.isArray(remotePayload) ? remotePayload : [];
      const mergedMessages = mergeHistoryMessages(localMessages, remoteMessages);
      const persisted = setCachedMessages(sessionKey, mergedMessages, { label: sessionLabelForKey(sessionKey), touchSession: sessionKey !== 'default' });
      if (state.currentSessionKey !== sessionKey) return;
      container.innerHTML = '';
      renderHistoryMessages(persisted);
    } catch {
      // no-op
    }
    updateEmptyState();
  }
  function countAssistantMessages(messages) {
    return messages.filter((message) => message?.role === 'assistant').length;
  }
  function renderMergedMessages(messages) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    container.innerHTML = '';
    renderHistoryMessages(messages);
    updateEmptyState();
    scrollChatToBottom();
  }
  async function attemptHistoryRecovery() {
    if (historyRecoveryInFlight || !getAssistantPending() || getIsStreaming()) return;
    const pendingChatRequest = getPendingChatRequest();
    if (!pendingChatRequest || !gateway.connected) return;
    const elapsed = Date.now() - pendingChatRequest.startedAt;
    if (elapsed > HISTORY_RECOVERY_STALE_MS) {
      setAssistantPending(false);
      setAssistantStalled(false);
      clearTypingIndicator();
      syncStreamingUiState();
      return;
    }
    historyRecoveryInFlight = true;
    try {
      await ensureChatCacheLoaded();
      const sessionKey = pendingChatRequest.sessionKey || 'default';
      const remoteSessionKey = normalizeSessionKeyForGateway(sessionKey);
      const localMessages = getCachedMessages(sessionKey);
      const remotePayload = await gateway.chatHistory(remoteSessionKey, 50);
      const remoteMessages = Array.isArray(remotePayload) ? remotePayload : [];
      const mergedMessages = mergeHistoryMessages(localMessages, remoteMessages);
      const persisted = setCachedMessages(sessionKey, mergedMessages, { label: sessionLabelForKey(sessionKey), touchSession: sessionKey !== 'default' });
      if (state.currentSessionKey === sessionKey && persisted.length !== localMessages.length) renderMergedMessages(persisted);
      if (countAssistantMessages(persisted) > pendingChatRequest.assistantCountAtSend) {
        setAssistantPending(false);
        setAssistantStalled(false);
        setPendingChatRequest(null);
        clearTypingIndicator();
        syncStreamingUiState();
      }
    } catch {
      // no-op
    } finally {
      historyRecoveryInFlight = false;
    }
  }
  function startHistoryRecoveryLoop() {
    clearHistoryRecoveryTimer();
    historyRecoveryInFlight = false;
    historyRecoveryTimer = setInterval(() => { void attemptHistoryRecovery(); }, HISTORY_RECOVERY_POLL_MS);
  }
  async function hydrateChatFromCache() {
    await ensureChatCacheLoaded();
    const cachedSessions = getCachedSessions();
    if (!state.sessions.length && cachedSessions.length) {
      state.sessions = cachedSessions;
      renderSessions();
    }
    const lastSessionKey = localStorage.getItem('tgclaw:lastSessionKey');
    if (lastSessionKey && lastSessionKey !== 'default' && state.sessions.some((session) => session?.sessionKey === lastSessionKey)) {
      selectItem(`session:${lastSessionKey}`);
      return;
    }
    void reloadChatHistory();
  }
  return {
    normalizeSessionKeyForGateway,
    applyGatewaySessionDefaults,
    clearHistoryRecoveryTimer,
    sessionLabelForKey,
    startHistoryRecoveryLoop,
    hydrateChatFromCache,
    reloadChatHistory,
  };
}
