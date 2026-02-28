const DEVICE_IDENTITY_STORAGE_KEY = 'tgclaw.gateway.deviceIdentity.v1';

const identityCache = new Map();
const privateKeyCache = new Map();

function getStorageKey(role) {
  if (role === 'node') return DEVICE_IDENTITY_STORAGE_KEY + '.node';
  return DEVICE_IDENTITY_STORAGE_KEY;
}

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

function readStoredDeviceIdentity(role) {
  try {
    const raw = localStorage.getItem(getStorageKey(role));
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

function storeDeviceIdentity(identity, role) {
  try {
    localStorage.setItem(getStorageKey(role), JSON.stringify({
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

async function createDeviceIdentity(role) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const deviceId = await sha256Hex(publicKeyRaw);
  const identity = {
    deviceId,
    publicKeyRaw: base64UrlEncode(publicKeyRaw),
    privateKeyPkcs8: base64UrlEncode(privateKeyPkcs8),
  };
  storeDeviceIdentity(identity, role);
  return identity;
}

async function loadOrCreateDeviceIdentity(role = 'operator') {
  const cacheKey = role || 'operator';
  if (identityCache.has(cacheKey)) return identityCache.get(cacheKey);
  const stored = readStoredDeviceIdentity(role);
  if (stored) {
    identityCache.set(cacheKey, stored);
    return stored;
  }
  const created = await createDeviceIdentity(role);
  identityCache.set(cacheKey, created);
  return created;
}

async function getDevicePrivateKey(identity, role = 'operator') {
  const cacheKey = identity.deviceId;
  if (privateKeyCache.has(cacheKey)) return privateKeyCache.get(cacheKey);
  const privateBytes = base64UrlDecode(identity.privateKeyPkcs8);
  const key = await crypto.subtle.importKey('pkcs8', privateBytes, { name: 'Ed25519' }, false, ['sign']);
  privateKeyCache.set(cacheKey, key);
  return key;
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
  const identity = await loadOrCreateDeviceIdentity(role);
  const privateKey = await getDevicePrivateKey(identity, role);
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
