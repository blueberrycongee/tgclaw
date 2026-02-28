const CACHE_VERSION = 1;
const MAX_SESSIONS = 200;
const MAX_MESSAGES_PER_SESSION = 500;
const SAVE_DEBOUNCE_MS = 150;

function emptyCache() {
  return {
    version: CACHE_VERSION,
    sessions: [],
    messagesBySession: {},
  };
}

let cache = emptyCache();
let loaded = false;
let loadPromise = null;
let saveTimer = null;

function normalizeSessionKey(sessionKey) {
  return typeof sessionKey === 'string' && sessionKey.trim() ? sessionKey.trim() : 'default';
}

function normalizeTimestamp(value) {
  const date = new Date(value);
  const timestamp = date.getTime();
  if (Number.isFinite(timestamp)) return timestamp;
  return Date.now();
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return null;
  const sessionKey = normalizeSessionKey(session.sessionKey);
  if (sessionKey === 'default') return null;
  const label = typeof session.label === 'string' && session.label.trim() ? session.label.trim() : sessionKey;
  const updatedAt = normalizeTimestamp(session.updatedAt ?? session.createdAt ?? Date.now());
  return { sessionKey, label, updatedAt };
}

function normalizeRole(role) {
  if (role === 'assistant' || role === 'bot') return 'assistant';
  return 'user';
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content.trim()) return null;
  const role = normalizeRole(message.role);
  const createdAt = normalizeTimestamp(message.createdAt ?? Date.now());
  const id = typeof message.id === 'string' && message.id
    ? message.id
    : `${role}-${createdAt}-${Math.random().toString(16).slice(2, 8)}`;
  return { id, role, content, createdAt };
}

function compactConsecutiveDuplicates(messages) {
  const compacted = [];
  messages.forEach((message) => {
    const previous = compacted[compacted.length - 1];
    if (previous && previous.role === message.role && previous.content === message.content) return;
    compacted.push(message);
  });
  return compacted;
}

function normalizeMessages(messages) {
  const normalized = Array.isArray(messages) ? messages.map(normalizeMessage).filter(Boolean) : [];
  const sorted = normalized.sort((left, right) => left.createdAt - right.createdAt);
  const compacted = compactConsecutiveDuplicates(sorted);
  return compacted.slice(-MAX_MESSAGES_PER_SESSION);
}

function normalizeMessagesBySession(messagesBySession) {
  if (!messagesBySession || typeof messagesBySession !== 'object') return {};
  const normalized = {};
  Object.entries(messagesBySession).forEach(([sessionKey, messages]) => {
    const key = normalizeSessionKey(sessionKey);
    normalized[key] = normalizeMessages(messages);
  });
  return normalized;
}

function normalizeCache(rawCache) {
  const sessions = Array.isArray(rawCache?.sessions)
    ? rawCache.sessions.map(normalizeSession).filter(Boolean)
    : [];
  const dedupedSessions = [];
  const seen = new Set();
  sessions.forEach((session) => {
    if (seen.has(session.sessionKey)) return;
    seen.add(session.sessionKey);
    dedupedSessions.push(session);
  });
  dedupedSessions.sort((left, right) => right.updatedAt - left.updatedAt);
  return {
    version: CACHE_VERSION,
    sessions: dedupedSessions.slice(0, MAX_SESSIONS),
    messagesBySession: normalizeMessagesBySession(rawCache?.messagesBySession),
  };
}

async function persistCache() {
  if (typeof window?.tgclaw?.saveChatCache !== 'function') return;
  try {
    await window.tgclaw.saveChatCache(cache);
  } catch {
    // Ignore persistence failures and keep in-memory cache available.
  }
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistCache();
  }, SAVE_DEBOUNCE_MS);
}

function touchSession(sessionKey, label = '') {
  if (sessionKey === 'default') return;
  const normalized = normalizeSession({ sessionKey, label, updatedAt: Date.now() });
  if (!normalized) return;
  const index = cache.sessions.findIndex((item) => item.sessionKey === normalized.sessionKey);
  if (index === -1) cache.sessions.unshift(normalized);
  else cache.sessions[index] = { ...cache.sessions[index], ...normalized };
  cache.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  cache.sessions = cache.sessions.slice(0, MAX_SESSIONS);
}

export async function ensureChatCacheLoaded() {
  if (loaded) return cache;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (typeof window?.tgclaw?.getChatCache !== 'function') {
      cache = emptyCache();
      loaded = true;
      return cache;
    }

    try {
      const raw = await window.tgclaw.getChatCache();
      cache = normalizeCache(raw);
    } catch {
      cache = emptyCache();
    }
    loaded = true;
    return cache;
  })();

  return loadPromise;
}

export function getCachedSessions() {
  return cache.sessions.map((session) => ({ ...session }));
}

export function setCachedSessions(nextSessions) {
  const normalized = Array.isArray(nextSessions) ? nextSessions.map(normalizeSession).filter(Boolean) : [];
  const deduped = [];
  const seen = new Set();
  normalized.forEach((session) => {
    if (seen.has(session.sessionKey)) return;
    seen.add(session.sessionKey);
    deduped.push(session);
  });
  deduped.sort((left, right) => right.updatedAt - left.updatedAt);
  cache.sessions = deduped.slice(0, MAX_SESSIONS);
  schedulePersist();
}

export function upsertCachedSession(session) {
  const normalized = normalizeSession(session);
  if (!normalized) return;
  touchSession(normalized.sessionKey, normalized.label);
  schedulePersist();
}

export function removeCachedSession(sessionKey, options = {}) {
  const key = normalizeSessionKey(sessionKey);
  if (key === 'default') return;
  cache.sessions = cache.sessions.filter((session) => session.sessionKey !== key);
  if (options.keepMessages !== true) delete cache.messagesBySession[key];
  schedulePersist();
}

export function getCachedMessages(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  const messages = cache.messagesBySession[key] || [];
  return messages.map((message) => ({ ...message }));
}

export function setCachedMessages(sessionKey, messages, options = {}) {
  const key = normalizeSessionKey(sessionKey);
  cache.messagesBySession[key] = normalizeMessages(messages);
  if (options.touchSession !== false) touchSession(key, options.label || '');
  schedulePersist();
  return getCachedMessages(key);
}

export function appendCachedMessage(sessionKey, message, options = {}) {
  const key = normalizeSessionKey(sessionKey);
  const normalized = normalizeMessage(message);
  if (!normalized) return null;
  const current = cache.messagesBySession[key] || [];
  const next = compactConsecutiveDuplicates([...current, normalized]).slice(-MAX_MESSAGES_PER_SESSION);
  cache.messagesBySession[key] = next;
  if (options.touchSession !== false) touchSession(key, options.label || '');
  schedulePersist();
  return { ...normalized };
}

