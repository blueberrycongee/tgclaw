type SessionRecipients = Map<string, Set<string>>;
type ConnSessions = Map<string, Set<string>>;

export type TerminalSessionSubscriptionRegistry = {
  attach: (connId: string, sessionId: string) => void;
  detach: (connId: string, sessionId: string) => void;
  detachAllForConn: (connId: string) => void;
  getRecipients: (sessionId: string) => ReadonlySet<string> | undefined;
};

function normalizeId(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createTerminalSessionSubscriptionRegistry(): TerminalSessionSubscriptionRegistry {
  const recipientsBySession: SessionRecipients = new Map();
  const sessionsByConn: ConnSessions = new Map();

  const attach = (connIdRaw: string, sessionIdRaw: string) => {
    const connId = normalizeId(connIdRaw);
    const sessionId = normalizeId(sessionIdRaw);
    if (!connId || !sessionId) {
      return;
    }

    let sessionRecipients = recipientsBySession.get(sessionId);
    if (!sessionRecipients) {
      sessionRecipients = new Set();
      recipientsBySession.set(sessionId, sessionRecipients);
    }
    sessionRecipients.add(connId);

    let connSessions = sessionsByConn.get(connId);
    if (!connSessions) {
      connSessions = new Set();
      sessionsByConn.set(connId, connSessions);
    }
    connSessions.add(sessionId);
  };

  const detach = (connIdRaw: string, sessionIdRaw: string) => {
    const connId = normalizeId(connIdRaw);
    const sessionId = normalizeId(sessionIdRaw);
    if (!connId || !sessionId) {
      return;
    }

    const sessionRecipients = recipientsBySession.get(sessionId);
    if (sessionRecipients) {
      sessionRecipients.delete(connId);
      if (sessionRecipients.size === 0) {
        recipientsBySession.delete(sessionId);
      }
    }

    const connSessions = sessionsByConn.get(connId);
    if (connSessions) {
      connSessions.delete(sessionId);
      if (connSessions.size === 0) {
        sessionsByConn.delete(connId);
      }
    }
  };

  const detachAllForConn = (connIdRaw: string) => {
    const connId = normalizeId(connIdRaw);
    if (!connId) {
      return;
    }
    const connSessions = sessionsByConn.get(connId);
    if (!connSessions || connSessions.size === 0) {
      sessionsByConn.delete(connId);
      return;
    }
    for (const sessionId of connSessions) {
      const sessionRecipients = recipientsBySession.get(sessionId);
      if (!sessionRecipients) {
        continue;
      }
      sessionRecipients.delete(connId);
      if (sessionRecipients.size === 0) {
        recipientsBySession.delete(sessionId);
      }
    }
    sessionsByConn.delete(connId);
  };

  const getRecipients = (sessionIdRaw: string) => {
    const sessionId = normalizeId(sessionIdRaw);
    if (!sessionId) {
      return undefined;
    }
    return recipientsBySession.get(sessionId);
  };

  return {
    attach,
    detach,
    detachAllForConn,
    getRecipients,
  };
}
