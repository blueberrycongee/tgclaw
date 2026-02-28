import { buildDeviceAuthSignature, randomId } from './gateway-identity.js';
const PROTOCOL_VERSION = 3;
const CLIENT_VERSION = '1.0.0';
const CLIENT_PLATFORM = 'electron', CLIENT_DEVICE_FAMILY = 'desktop';
const DEFAULT_SCOPES = ['operator.admin', 'operator.read', 'operator.write'];
const DEFAULT_NODE_COMMANDS = ['system.run', 'system.execApprovals.get', 'system.execApprovals.set'];
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;
function buildError(message, code, details) {
  const error = new Error(code ? `${message} (${code})` : message);
  if (code) error.code = code;
  if (details && typeof details === 'object') error.details = details;
  return error;
}
class GatewayClient {
  constructor(defaultUrl = '', options = {}) {
    this.defaultUrl = defaultUrl;
    this.url = defaultUrl;
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
    this.enableDeviceSignature = true;
    this.role = options.role || 'operator';
    this.clientId = options.clientId || 'tgclaw';
    this.clientMode = options.clientMode || 'operator';
    this.commands = options.commands || [];
  }
  connect(url = this.defaultUrl, token = '') {
    this.url = typeof url === 'string' && url ? url : this.defaultUrl;
    this.token = typeof token === 'string' ? token : '';
    this.manualDisconnect = false;
    this.reconnectAttempts = 0;
    this._clearReconnectTimer();
    return this._openSocket();
  }
  disconnect() {
    this.manualDisconnect = true;
    this._clearReconnectTimer();
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return this.ws.close();
    this._setDisconnected();
    this._emit('disconnected');
  }
  send(method, params = {}) { return this.connected ? this._request(method, params) : Promise.reject(new Error('Gateway is not connected')); }
  on(event, callback) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(callback); }
  off(event, callback) { this.listeners.get(event)?.delete(callback); }
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Gateway socket is not open'));
    const id = randomId();
    const payload = { type: 'req', id, method };
    if (typeof params !== 'undefined') payload.params = params;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); } catch (err) { this.pending.delete(id); reject(err instanceof Error ? err : new Error(String(err))); }
    });
  }
  _onMessage(data) {
    let frame;
    try { frame = JSON.parse(data); } catch { return this._onError(new Error('Invalid gateway message')); }
    if (!frame || typeof frame !== 'object') return this._onError(new Error('Invalid gateway frame'));
    if (frame.type === 'res') return this._handleResponseFrame(frame);
    if (frame.type === 'event') return this._handleEventFrame(frame);
    this._onError(new Error('Unsupported gateway frame type'));
  }
  _handleResponseFrame(frame) {
    if (typeof frame.id !== 'string') return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) return pending.resolve(frame.payload);
    const message = typeof frame.error?.message === 'string' && frame.error.message ? frame.error.message : 'Gateway request failed';
    const code = typeof frame.error?.code === 'string' ? frame.error.code : '';
    pending.reject(buildError(message, code, frame.error?.details));
  }
  _handleEventFrame(frame) {
    if (frame.event === 'connect.challenge') return void this._handleConnectChallenge(frame.payload);
    if (frame.event === 'chat') return this._emit('chat', frame.payload ?? frame.data ?? frame.params ?? frame);
    if (frame.event === 'node.invoke.request') return this._emit('node.invoke.request', frame.payload ?? frame);
    this._emit('event', frame);
  }
  async _handleConnectChallenge(payload) {
    if (this.connected || this.handshakePromise) return;
    const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : '';
    if (!nonce) {
      const err = new Error('Gateway connect challenge missing nonce');
      this._onError(err);
      this._rejectConnect(err);
      this.ws?.close(4008, 'connect challenge missing nonce');
      return;
    }
    this.handshakePromise = (async () => {
      try {
        let hello;
        try { hello = await this._request('connect', await this._buildConnectParams(nonce, this.protocolVersion)); }
        catch (error) {
          const expectedProtocol = Number(error?.details?.expectedProtocol);
          const shouldRetry = error?.code === 'INVALID_REQUEST' && Number.isInteger(expectedProtocol) && expectedProtocol >= 1 && expectedProtocol !== this.protocolVersion;
          if (!shouldRetry) throw error;
          this.protocolVersion = expectedProtocol;
          hello = await this._request('connect', await this._buildConnectParams(nonce, this.protocolVersion));
        }
        if (!hello || hello.type !== 'hello-ok') throw new Error('Gateway connect handshake failed');
        this.connected = true;
        this.reconnectAttempts = 0;
        this._emit('connected', hello);
        this._resolveConnect();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this._onError(error);
        this._rejectConnect(error);
        this.ws?.close(4008, 'connect failed');
      } finally {
        this.handshakePromise = null;
      }
    })();
  }
  async _buildConnectParams(nonce, protocolVersion = this.protocolVersion) {
    const token = this.token.trim();
    const role = this.role;
    const scopes = [...DEFAULT_SCOPES];
    const params = {
      minProtocol: protocolVersion,
      maxProtocol: protocolVersion,
      client: { id: this.clientId, displayName: 'TGClaw', version: CLIENT_VERSION, platform: CLIENT_PLATFORM, deviceFamily: CLIENT_DEVICE_FAMILY, mode: this.clientMode },
      role,
      scopes,
    };
    if (this.commands.length > 0) {
      params.commands = [...this.commands];
    }
    if (this.enableDeviceSignature) {
      params.device = await buildDeviceAuthSignature({ nonce, token, role, scopes, clientId: this.clientId, clientMode: this.clientMode, platform: CLIENT_PLATFORM, deviceFamily: CLIENT_DEVICE_FAMILY });
    }
    if (token) params.auth = { token };
    return params;
  }
  _resolveConnect() { if (!this.connectResolve) return; const resolve = this.connectResolve; this.connectResolve = null; this.connectReject = null; resolve(); }
  _rejectConnect(error) { if (!this.connectReject) return; const reject = this.connectReject; this.connectResolve = null; this.connectReject = null; reject(error); }
  _onClose() { const shouldReconnect = !this.manualDisconnect; this._setDisconnected(); this._emit('disconnected'); if (shouldReconnect) this._scheduleReconnect(); }
  _onError(err) { this._emit('error', err instanceof Error ? err : new Error(String(err))); }
  _setDisconnected() { this.connected = false; this.ws = null; this.handshakePromise = null; this._rejectConnect(new Error('Gateway disconnected')); this._rejectPending(new Error('Gateway disconnected')); }
  _clearReconnectTimer() { if (!this.reconnectTimer) return; clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  _rejectPending(error) { this.pending.forEach(({ reject }) => reject(error)); this.pending.clear(); }
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
  _emit(event, payload) {
    this.listeners.get(event)?.forEach((callback) => {
      try { callback(payload); } catch (err) { console.error('Gateway listener error', err); }
    });
  }
  chatSend(sessionKey, message) { return this.send('chat.send', { sessionKey, message, deliver: false, idempotencyKey: randomId() }); }
  async chatHistory(sessionKey, limit) { const payload = await this.send('chat.history', { sessionKey, limit }); if (Array.isArray(payload)) return payload; return Array.isArray(payload?.messages) ? payload.messages : []; }
  chatAbort(sessionKey, runId) { return this.send('chat.abort', { sessionKey, runId }); }
  sessionsList() { return this.send('sessions.list', {}); }
  nodeInvokeResult(requestId, nodeId, ok, payload, error) {
    return this.send('node.invoke.result', { id: requestId, nodeId, ok, payload: ok ? payload : undefined, error: ok ? undefined : error });
  }
}
export { GatewayClient };
