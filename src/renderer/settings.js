import { gateway, nodeGateway } from './gateway.js';
import { state } from './state.js';
import { renderSessions, selectItem } from './sidebar.js';
import { ensureChatCacheLoaded, getCachedSessions, setCachedSessions } from './chat-cache.js';

const DEFAULT_GATEWAY_URL = 'ws://localhost:18789';

let settingsPanel = null;
let urlInput = null;
let tokenInput = null;
let statusText = null;
let autoConnectTried = false;
let savedGatewayToken = '';

function mergeSessions(remoteSessions, cachedSessions) {
  const merged = [];
  const seen = new Set();
  [...remoteSessions, ...cachedSessions].forEach((session) => {
    if (!session || typeof session.sessionKey !== 'string') return;
    const sessionKey = session.sessionKey.trim();
    if (!sessionKey || sessionKey === 'default' || seen.has(sessionKey)) return;
    seen.add(sessionKey);
    const label = typeof session.label === 'string' && session.label.trim() ? session.label.trim() : sessionKey;
    const updatedAt = Number.isFinite(new Date(session.updatedAt).getTime())
      ? new Date(session.updatedAt).getTime()
      : Date.now();
    merged.push({ sessionKey, label, updatedAt });
  });
  merged.sort((left, right) => right.updatedAt - left.updatedAt);
  return merged;
}

export async function initSettings() {
  settingsPanel = document.getElementById('gateway-settings');
  urlInput = document.getElementById('gateway-url');
  tokenInput = document.getElementById('gateway-token');
  statusText = document.getElementById('gateway-connection-status');

  document.getElementById('gateway-settings-btn')?.addEventListener('click', showSettings);
  document.getElementById('gateway-settings-close')?.addEventListener('click', hideSettings);
  document.getElementById('gateway-connect')?.addEventListener('click', () => {
    void handleConnect();
  });
  document.getElementById('gateway-disconnect')?.addEventListener('click', handleDisconnect);

  settingsPanel?.addEventListener('click', (event) => {
    if (event.target === settingsPanel) hideSettings();
  });

  gateway.on('connected', () => {
    updateConnectionStatus('connected');
    void syncSessionsFromGateway();
  });
  gateway.on('disconnected', () => updateConnectionStatus('disconnected'));
  gateway.on('error', () => updateConnectionStatus('disconnected'));
  gateway.on('pairing-required', () => updateConnectionStatus('pairing'));

  updateConnectionStatus(gateway.connected ? 'connected' : 'disconnected');
  await ensureChatCacheLoaded();
  const cachedSessions = getCachedSessions();
  if (!state.sessions.length && cachedSessions.length) {
    state.sessions = cachedSessions;
    renderSessions();
  }

  const config = await loadSavedConfig();

  if (!config.configured) {
    updateConnectionStatus('unconfigured');
    showSettings();
    return;
  }

  void attemptAutoConnect();
}

async function syncSessionsFromGateway() {
  const cachedSessions = getCachedSessions();
  try {
    const payload = await gateway.sessionsList();
    const remoteSessions = Array.isArray(payload?.sessions) ? payload.sessions : (Array.isArray(payload) ? payload : []);
    state.sessions = mergeSessions(remoteSessions, cachedSessions);
    setCachedSessions(state.sessions);
  } catch {
    state.sessions = cachedSessions;
  }
  renderSessions();
  const lastSessionKey = localStorage.getItem('tgclaw:lastSessionKey');
  if (
    lastSessionKey
    && lastSessionKey !== 'default'
    && state.sessions.some((session) => session?.sessionKey === lastSessionKey)
  ) {
    selectItem(`session:${lastSessionKey}`);
  }
}

async function loadSavedConfig() {
  const saved = await window.tgclaw.getGatewayConfig();
  const url = typeof saved?.url === 'string' && saved.url ? saved.url : DEFAULT_GATEWAY_URL;
  const token = typeof saved?.token === 'string' ? saved.token : '';
  const configured = saved?.configured === true;
  savedGatewayToken = token;
  if (urlInput) urlInput.value = url;
  if (tokenInput) tokenInput.value = token;
  return { url, token, configured };
}

async function attemptAutoConnect() {
  if (autoConnectTried || gateway.connected) return;
  autoConnectTried = true;

  await handleConnect({ persist: false, silentFailure: true });
  if (gateway.connected) return;

  const savedUrl = urlInput?.value.trim() || '';
  const fallbackUrls = [DEFAULT_GATEWAY_URL, 'ws://127.0.0.1:18789']
    .filter((url, index, arr) => arr.indexOf(url) === index && url !== savedUrl);

  for (const fallbackUrl of fallbackUrls) {
    await handleConnect({
      persist: false,
      silentFailure: true,
      urlOverride: fallbackUrl,
    });
    if (gateway.connected) {
      if (urlInput) urlInput.value = fallbackUrl;
      await window.tgclaw.saveGatewayConfig({
        url: fallbackUrl,
        token: tokenInput?.value || '',
        configured: true,
      });
      return;
    }
  }
}

export function showSettings() {
  settingsPanel?.classList.add('show');
}

export function hideSettings() {
  settingsPanel?.classList.remove('show');
}

export async function handleConnect(options = {}) {
  const persist = options.persist !== false;
  const silentFailure = options.silentFailure === true;
  const url = typeof options.urlOverride === 'string' && options.urlOverride.trim()
    ? options.urlOverride.trim()
    : (urlInput?.value.trim() || DEFAULT_GATEWAY_URL);
  const inputToken = typeof options.tokenOverride === 'string' ? options.tokenOverride : (tokenInput?.value || '');
  const token = inputToken || savedGatewayToken;

  updateConnectionStatus('connecting');
  if (persist) await window.tgclaw.saveGatewayConfig({ url, token, configured: true });

  try {
    await gateway.connect(url, token);
    // Also connect the node gateway for exec requests
    nodeGateway.connect(url, token).catch(() => {});
    savedGatewayToken = token;
    if (tokenInput && !tokenInput.value && token) tokenInput.value = token;
    updateConnectionStatus('connected');
    hideSettings();
  } catch {
    updateConnectionStatus('disconnected');
    if (!silentFailure) showSettings();
  }
}

export function handleDisconnect() {
  gateway.disconnect();
  updateConnectionStatus('disconnected');
}

export function updateConnectionStatus(status) {
  if (!statusText) return;

  statusText.classList.remove('connected', 'connecting', 'disconnected', 'unconfigured', 'pairing');

  if (status === 'connecting') {
    statusText.textContent = 'Connecting...';
    statusText.classList.add('connecting');
    return;
  }

  if (status === 'pairing') {
    statusText.textContent = 'Waiting for approval...';
    statusText.classList.add('pairing');
    return;
  }

  if (status === 'connected') {
    statusText.textContent = 'Connected';
    statusText.classList.add('connected');
    return;
  }

  if (status === 'unconfigured') {
    statusText.textContent = 'Needs setup';
    statusText.classList.add('unconfigured');
    return;
  }

  statusText.textContent = 'Disconnected';
  statusText.classList.add('disconnected');
}
