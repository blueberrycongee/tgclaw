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

async function buildDeviceAuthSignature({ nonce, token, role, scopes, clientId, clientMode, platform, deviceFamily }) {
  const identity = await loadOrCreateDeviceIdentity();
  const privateKey = await getDevicePrivateKey(identity);
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    signedAtMs: signedAt,
    token,
    nonce,
    platform,
    deviceFamily,
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

export {
  randomId,
  bytesToBase64,
  base64ToBytes,
  base64UrlEncode,
  base64UrlDecode,
  bytesToHex,
  normalizeAsciiLower,
  sha256Hex,
  readStoredDeviceIdentity,
  storeDeviceIdentity,
  createDeviceIdentity,
  loadOrCreateDeviceIdentity,
  getDevicePrivateKey,
  buildDeviceAuthPayloadV3,
  buildDeviceAuthSignature,
};
