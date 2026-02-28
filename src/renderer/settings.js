import { gateway } from './gateway.js';
import { state } from './state.js';
import { renderSessions, selectItem } from './sidebar.js';

const DEFAULT_GATEWAY_URL = 'ws://localhost:18789';

let settingsPanel = null;
let urlInput = null;
let tokenInput = null;
let statusText = null;
let autoConnectTried = false;

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
  gateway.on('disconnected', () => {
    updateConnectionStatus('disconnected');
    state.sessions = [];
    renderSessions();
  });
  gateway.on('error', () => updateConnectionStatus('disconnected'));

  updateConnectionStatus(gateway.connected ? 'connected' : 'disconnected');
  const config = await loadSavedConfig();

  if (!config.configured) {
    updateConnectionStatus('unconfigured');
    showSettings();
    return;
  }

  void attemptAutoConnect();
}

async function syncSessionsFromGateway() {
  try {
    const sessions = await gateway.sessionsList();
    state.sessions = Array.isArray(sessions) ? sessions : [];
  } catch {
    state.sessions = [];
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
  if (urlInput) urlInput.value = url;
  if (tokenInput) tokenInput.value = token;
  return { url, token, configured };
}

async function attemptAutoConnect() {
  if (autoConnectTried || gateway.connected) return;
  autoConnectTried = true;
  await handleConnect({ persist: false, silentFailure: true });
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
  const url = urlInput?.value.trim() || DEFAULT_GATEWAY_URL;
  const token = tokenInput?.value || '';

  updateConnectionStatus('connecting');
  if (persist) await window.tgclaw.saveGatewayConfig({ url, token, configured: true });

  try {
    await gateway.connect(url, token);
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

  statusText.classList.remove('connected', 'connecting', 'disconnected', 'unconfigured');

  if (status === 'connecting') {
    statusText.textContent = 'Connecting...';
    statusText.classList.add('connecting');
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
