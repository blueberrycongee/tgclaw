import { gateway } from './gateway.js';

const DEFAULT_GATEWAY_URL = 'ws://localhost:18789';

let settingsPanel = null;
let urlInput = null;
let tokenInput = null;
let statusText = null;

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

  gateway.on('connected', () => updateConnectionStatus('connected'));
  gateway.on('disconnected', () => updateConnectionStatus('disconnected'));
  gateway.on('error', () => updateConnectionStatus('disconnected'));

  updateConnectionStatus(gateway.connected ? 'connected' : 'disconnected');
  await loadSavedConfig();
}

async function loadSavedConfig() {
  const saved = await window.tgclaw.getGatewayConfig();
  const url = typeof saved?.url === 'string' && saved.url ? saved.url : DEFAULT_GATEWAY_URL;
  const token = typeof saved?.token === 'string' ? saved.token : '';
  if (urlInput) urlInput.value = url;
  if (tokenInput) tokenInput.value = token;
}

export function showSettings() {
  settingsPanel?.classList.add('show');
}

export function hideSettings() {
  settingsPanel?.classList.remove('show');
}

export async function handleConnect() {
  const url = urlInput?.value.trim() || DEFAULT_GATEWAY_URL;
  const token = tokenInput?.value || '';

  updateConnectionStatus('connecting');
  await window.tgclaw.saveGatewayConfig({ url, token });

  try {
    await gateway.connect(url, token);
    updateConnectionStatus('connected');
  } catch {
    updateConnectionStatus('disconnected');
  }
}

export function handleDisconnect() {
  gateway.disconnect();
  updateConnectionStatus('disconnected');
}

export function updateConnectionStatus(status) {
  if (!statusText) return;

  statusText.classList.remove('connected', 'connecting', 'disconnected');

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

  statusText.textContent = 'Disconnected';
  statusText.classList.add('disconnected');
}
