const DEFAULT_GATEWAY_URL = 'ws://localhost:18789';
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

const PROTOCOL_VERSION = 3;
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const CLIENT_VERSION = '1.0.0';
const CLIENT_PLATFORM = 'electron';
const CLIENT_DEVICE_FAMILY = 'desktop';
const DEFAULT_ROLE = 'operator';
const DEFAULT_SCOPES = ['operator.admin'];

const DEVICE_IDENTITY_STORAGE_KEY = 'tgclaw.gateway.deviceIdentity.v1';

let cachedDeviceIdentity = null;
let cachedPrivateKey = null;

function randomId() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function base64UrlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = String(input || '').replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return base64ToBytes(padded);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizeAsciiLower(value) {
  return String(value || '').trim().toLowerCase();
}

async function sha256Hex(bytes) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(hashBuffer));
}

function readStoredDeviceIdentity() {
  try {
    const raw = localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return null;
    if (
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.publicKeyRaw !== 'string' ||
      typeof parsed.privateKeyPkcs8 !== 'string'
    ) {
      return null;
    }
    return {
      deviceId: parsed.deviceId,
      publicKeyRaw: parsed.publicKeyRaw,
      privateKeyPkcs8: parsed.privateKeyPkcs8,
    };
  } catch {
    return null;
  }
}

function storeDeviceIdentity(identity) {
  try {
    localStorage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify({
      version: 1,
      deviceId: identity.deviceId,
      publicKeyRaw: identity.publicKeyRaw,
      privateKeyPkcs8: identity.privateKeyPkcs8,
      createdAtMs: Date.now(),
    }));
  } catch {
    // Ignore storage failures; memory cache still works for this session.
  }
}

async function createDeviceIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const deviceId = await sha256Hex(publicKeyRaw);
  const identity = {
    deviceId,
    publicKeyRaw: base64UrlEncode(publicKeyRaw),
    privateKeyPkcs8: base64UrlEncode(privateKeyPkcs8),
  };
  storeDeviceIdentity(identity);
  return identity;
}

async function loadOrCreateDeviceIdentity() {
  if (cachedDeviceIdentity) return cachedDeviceIdentity;

  const stored = readStoredDeviceIdentity();
  if (stored) {
    cachedDeviceIdentity = stored;
    return stored;
  }

  const created = await createDeviceIdentity();
  cachedDeviceIdentity = created;
  return created;
}

async function getDevicePrivateKey(identity) {
  if (cachedPrivateKey) return cachedPrivateKey;
  const privateBytes = base64UrlDecode(identity.privateKeyPkcs8);
  cachedPrivateKey = await crypto.subtle.importKey('pkcs8', privateBytes, { name: 'Ed25519' }, false, ['sign']);
  return cachedPrivateKey;
}

function buildDeviceAuthPayloadV3({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily }) {
  return [
    'v3',
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAtMs),
    token || '',
    nonce,
    normalizeAsciiLower(platform),
    normalizeAsciiLower(deviceFamily),
  ].join('|');
}

async function buildDeviceAuthSignature({ nonce, token, role, scopes }) {
  const identity = await loadOrCreateDeviceIdentity();
  const privateKey = await getDevicePrivateKey(identity);
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: CLIENT_ID,
    clientMode: CLIENT_MODE,
    role,
    scopes,
    signedAtMs: signedAt,
    token,
    nonce,
    platform: CLIENT_PLATFORM,
    deviceFamily: CLIENT_DEVICE_FAMILY,
  });
  const signatureBytes = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(payload));
  return {
    id: identity.deviceId,
    publicKey: identity.publicKeyRaw,
    signature: base64UrlEncode(new Uint8Array(signatureBytes)),
    signedAt,
    nonce,
  };
}

function buildError(message, code, details) {
  const error = new Error(code ? `${message} (${code})` : message);
  if (code) error.code = code;
  if (details && typeof details === 'object') error.details = details;
  return error;
}

class GatewayClient {
  constructor() {
    this.url = DEFAULT_GATEWAY_URL;
    this.token = '';
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.listeners = new Map();
    this.pending = new Map();
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.reconnectAttempts = 0;
    this.manualDisconnect = false;
    this.handshakePromise = null;
    this.protocolVersion = PROTOCOL_VERSION;
  }

  connect(url = DEFAULT_GATEWAY_URL, token = '') {
    this.url = typeof url === 'string' && url ? url : DEFAULT_GATEWAY_URL;
    this.token = typeof token === 'string' ? token : '';
    this.manualDisconnect = false;
    this.reconnectAttempts = 0;
    this._clearReconnectTimer();
    return this._openSocket();
  }

  disconnect() {
    this.manualDisconnect = true;
    this._clearReconnectTimer();
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
      return;
    }
    this._setDisconnected();
    this._emit('disconnected');
  }

  send(method, params = {}) {
    if (!this.connected) return Promise.reject(new Error('Gateway is not connected'));
    return this._request(method, params);
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(callback);
  }

  off(event, callback) {
    this.listeners.get(event)?.delete(callback);
  }

  _openSocket() {
    if (!this.url) return Promise.reject(new Error('Gateway URL is required'));
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        this._rejectConnect(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.ws = ws;
      this.connected = false;
      this.handshakePromise = null;

      ws.onopen = () => {
        this.reconnectAttempts = 0;
      };

      ws.onmessage = (event) => this._onMessage(event.data);
      ws.onerror = () => this._onError(new Error('Gateway WebSocket error'));
      ws.onclose = () => this._onClose();
    }).finally(() => {
      this.connectPromise = null;
      this.connectResolve = null;
      this.connectReject = null;
    });

    return this.connectPromise;
  }

  _request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Gateway socket is not open'));
    }

    const id = randomId();
    const payload = {
      type: 'req',
      id,
      method,
    };
    if (typeof params !== 'undefined') payload.params = params;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  _onMessage(data) {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      this._onError(new Error('Invalid gateway message'));
      return;
    }

    if (!frame || typeof frame !== 'object') {
      this._onError(new Error('Invalid gateway frame'));
      return;
    }

    if (frame.type === 'res') {
      this._handleResponseFrame(frame);
      return;
    }

    if (frame.type === 'event') {
      this._handleEventFrame(frame);
      return;
    }

    this._onError(new Error('Unsupported gateway frame type'));
  }

  _handleResponseFrame(frame) {
    if (typeof frame.id !== 'string') return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;

    this.pending.delete(frame.id);
    if (!frame.ok) {
      const message = typeof frame.error?.message === 'string' && frame.error.message
        ? frame.error.message
        : 'Gateway request failed';
      const code = typeof frame.error?.code === 'string' ? frame.error.code : '';
      const details = frame.error?.details;
      pending.reject(buildError(message, code, details));
      return;
    }

    pending.resolve(frame.payload);
  }

  _handleEventFrame(frame) {
    if (frame.event === 'connect.challenge') {
      void this._handleConnectChallenge(frame.payload);
      return;
    }

    if (frame.event === 'chat') {
      this._emit('chat', frame.payload ?? frame.data ?? frame.params ?? frame);
      return;
    }

    this._emit('event', frame);
  }

  async _handleConnectChallenge(payload) {
    if (this.connected || this.handshakePromise) return;

    const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : '';
    if (!nonce) {
      const err = new Error('Gateway connect challenge missing nonce');
      this._onError(err);
      this._rejectConnect(err);
      this.ws?.close(1008, 'connect challenge missing nonce');
      return;
    }

    this.handshakePromise = (async () => {
      try {
        let hello;
        try {
          const connectParams = await this._buildConnectParams(nonce, this.protocolVersion);
          hello = await this._request('connect', connectParams);
        } catch (error) {
          const expectedProtocol = Number(error?.details?.expectedProtocol);
          const shouldRetryWithExpectedProtocol = (
            error?.code === 'INVALID_REQUEST' &&
            Number.isInteger(expectedProtocol) &&
            expectedProtocol >= 1 &&
            expectedProtocol !== this.protocolVersion
          );
          if (!shouldRetryWithExpectedProtocol) throw error;

          this.protocolVersion = expectedProtocol;
          const retryParams = await this._buildConnectParams(nonce, this.protocolVersion);
          hello = await this._request('connect', retryParams);
        }

        if (!hello || hello.type !== 'hello-ok') {
          throw new Error('Gateway connect handshake failed');
        }

        this.connected = true;
        this.reconnectAttempts = 0;
        this._emit('connected', hello);
        this._resolveConnect();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this._onError(error);
        this._rejectConnect(error);
        this.ws?.close(1008, 'connect failed');
      } finally {
        this.handshakePromise = null;
      }
    })();
  }

  async _buildConnectParams(nonce, protocolVersion = this.protocolVersion) {
    const token = this.token.trim();
    const role = DEFAULT_ROLE;
    const scopes = [...DEFAULT_SCOPES];

    const params = {
      minProtocol: protocolVersion,
      maxProtocol: protocolVersion,
      client: {
        id: CLIENT_ID,
        displayName: 'TGClaw',
        version: CLIENT_VERSION,
        platform: CLIENT_PLATFORM,
        deviceFamily: CLIENT_DEVICE_FAMILY,
        mode: CLIENT_MODE,
      },
      role,
      scopes,
    };

    if (token) {
      params.auth = { token };
    }

    // With shared-token auth enabled, skip device auth by default to avoid
    // triggering gateway pairing requirements for desktop app connections.
    if (!token) {
      try {
        const device = await buildDeviceAuthSignature({ nonce, token, role, scopes });
        params.device = device;
      } catch (err) {
        // Continue without device signature so shared-token auth still works.
        console.warn('Failed to build gateway device signature', err);
      }
    }

    return params;
  }

  _resolveConnect() {
    if (!this.connectResolve) return;
    const resolve = this.connectResolve;
    this.connectResolve = null;
    this.connectReject = null;
    resolve();
  }

  _rejectConnect(error) {
    if (!this.connectReject) return;
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    reject(error);
  }

  _onClose() {
    const shouldReconnect = !this.manualDisconnect;
    this._setDisconnected();
    this._emit('disconnected');
    if (shouldReconnect) this._scheduleReconnect();
  }

  _onError(err) {
    this._emit('error', err instanceof Error ? err : new Error(String(err)));
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS || !this.url) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts += 1;
      this._openSocket().catch(() => {
        if (!this.connected && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) this._scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  _setDisconnected() {
    this.connected = false;
    this.ws = null;
    this.handshakePromise = null;
    this._rejectConnect(new Error('Gateway disconnected'));
    this._rejectPending(new Error('Gateway disconnected'));
  }

  _clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  _rejectPending(error) {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }

  _emit(event, payload) {
    this.listeners.get(event)?.forEach((callback) => {
      try {
        callback(payload);
      } catch (err) {
        console.error('Gateway listener error', err);
      }
    });
  }

  chatSend(sessionKey, message) {
    return this.send('chat.send', { sessionKey, message, idempotencyKey: randomId() });
  }

  async chatHistory(sessionKey, limit) {
    const payload = await this.send('chat.history', { sessionKey, limit });
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.messages)) return payload.messages;
    return [];
  }

  chatAbort(sessionKey, runId) {
    return this.send('chat.abort', { sessionKey, runId });
  }

  sessionsList() {
    return this.send('sessions.list', {});
  }
}

export const gateway = new GatewayClient();
