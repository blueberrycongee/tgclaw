const DEFAULT_GATEWAY_URL = 'ws://localhost:18789';
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

class GatewayClient {
  constructor() {
    this.url = DEFAULT_GATEWAY_URL;
    this.token = '';
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.listeners = new Map();
    this.nextId = 1;
    this.pending = new Map();
    this.connectPromise = null;
    this.reconnectAttempts = 0;
    this.manualDisconnect = false;
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Gateway is not connected'));
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', method, id, params };
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
  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(callback);
  }
  off(event, callback) {
    this.listeners.get(event)?.delete(callback);
  }
  _openSocket() {
    if (!this.url) return Promise.reject(new Error('Gateway URL is required'));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this._emit('connected');
        this._sendHello();
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.onmessage = (event) => this._onMessage(event.data);
      ws.onerror = () => this._onError(new Error('Gateway WebSocket error'));
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Gateway connection closed'));
        }
        this._onClose();
      };
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }
  _sendHello() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'hello',
      id: this.nextId++,
      params: {
        client: { id: 'tgclaw', mode: 'ui', version: '1.0.0', platform: 'electron' },
        auth: { token: this.token },
        minProtocol: 1,
        maxProtocol: 1,
      },
    }));
  }
  _onMessage(data) {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      this._onError(new Error('Invalid gateway message'));
      return;
    }
    if (frame && typeof frame.id !== 'undefined') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message || 'Gateway RPC error'));
      else pending.resolve(frame.result);
      return;
    }
    if (frame?.type === 'event' && frame.event === 'chat') this._emit('chat', frame.data ?? frame.params ?? frame.payload ?? frame);
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
    return this.send('chat.send', { sessionKey, message, idempotencyKey: crypto.randomUUID() });
  }
  chatHistory(sessionKey, limit) {
    return this.send('chat.history', { sessionKey, limit });
  }
  sessionsList() {
    return this.send('sessions.list', {});
  }
}
export const gateway = new GatewayClient();
