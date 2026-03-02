import {
  getFinishedSession,
  getSession,
  type ProcessSession,
} from "../../agents/bash-process-registry.js";
import { publishProcessSessionEvent } from "../../agents/process-session-events.js";
import { encodeKeySequence, encodePaste } from "../../agents/pty-keys.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type WritableStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  destroyed?: boolean;
};

function resolveSessionId(params: Record<string, unknown>): string {
  const candidates = [params.sessionId, params.terminalSessionId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function readRecentOutput(session: ProcessSession): string {
  const raw = typeof session.rawTail === "string" ? session.rawTail : "";
  if (raw) {
    return raw;
  }
  return session.tail || session.aggregated || "";
}

function resolveSessionStatus(session: ProcessSession):
  | "running"
  | "completed"
  | "failed"
  | "killed" {
  if (!session.exited) {
    return "running";
  }
  if (session.exitSignal === "SIGKILL") {
    return "killed";
  }
  if ((session.exitCode ?? 0) === 0 && session.exitSignal == null) {
    return "completed";
  }
  return "failed";
}

function resolveWritableSession(
  sessionId: string,
): { session: ProcessSession; stdin: WritableStdin } | { error: string } {
  const session = getSession(sessionId);
  if (!session) {
    return { error: `No active session found for ${sessionId}` };
  }
  if (!session.backgrounded) {
    return { error: `Session ${sessionId} is not backgrounded.` };
  }
  const stdin = (session.stdin ?? session.child?.stdin) as WritableStdin | undefined;
  if (!stdin || stdin.destroyed) {
    return { error: `Session ${sessionId} stdin is not writable.` };
  }
  return { session, stdin };
}

async function writeStdin(stdin: WritableStdin, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stdin.write(data, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function parseDimension(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(1, Math.floor(value));
}

function emitOperatorInput(sessionId: string, data: string): void {
  if (!data) {
    return;
  }
  publishProcessSessionEvent({
    type: "input",
    sessionId,
    data,
    actor: "operator",
    ts: Date.now(),
  });
}

export const terminalSessionHandlers: GatewayRequestHandlers = {
  "terminal.session.attach": ({ params, respond, context, client }) => {
    if (typeof context.attachTerminalSession !== "function") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "terminal session streaming is unavailable"),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "client connection missing"));
      return;
    }
    const sessionId = resolveSessionId(params);
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }

    const running = getSession(sessionId);
    if (running) {
      context.attachTerminalSession(connId, sessionId);
      const status = resolveSessionStatus(running);
      respond(true, {
        sessionId,
        status,
        command: running.command,
        cwd: running.cwd,
        pid: running.pid ?? undefined,
        startedAt: running.startedAt,
        exited: running.exited,
        exitCode: running.exitCode ?? undefined,
        exitSignal: running.exitSignal ?? undefined,
        backgrounded: running.backgrounded,
        canWrite:
          running.backgrounded &&
          Boolean((running.stdin ?? running.child?.stdin) && !(running.stdin?.destroyed ?? false)),
        cursor: running.outputCursor ?? 0,
        recentOutput: readRecentOutput(running),
      });
      return;
    }

    const finished = getFinishedSession(sessionId);
    if (!finished) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `No session found for ${sessionId}`),
      );
      return;
    }
    context.attachTerminalSession(connId, sessionId);
    respond(true, {
      sessionId,
      status: finished.status,
      command: finished.command,
      cwd: finished.cwd,
      pid: undefined,
      startedAt: finished.startedAt,
      endedAt: finished.endedAt,
      exited: true,
      exitCode: finished.exitCode ?? undefined,
      exitSignal: finished.exitSignal ?? undefined,
      backgrounded: true,
      canWrite: false,
      cursor: finished.aggregated.length,
      recentOutput: finished.aggregated,
    });
  },

  "terminal.session.detach": ({ params, respond, context, client }) => {
    if (typeof context.detachTerminalSession !== "function") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "terminal session streaming is unavailable"),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "client connection missing"));
      return;
    }
    const sessionId = resolveSessionId(params);
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    context.detachTerminalSession(connId, sessionId);
    respond(true, { sessionId, detached: true });
  },

  "terminal.session.write": async ({ params, respond }) => {
    const sessionId = resolveSessionId(params);
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    const resolved = resolveWritableSession(sessionId);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const data = typeof params.data === "string" ? params.data : "";
    const eof = params.eof === true;
    if (!data && !eof) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "write data is required"));
      return;
    }
    try {
      if (data) {
        await writeStdin(resolved.stdin, data);
        emitOperatorInput(sessionId, data);
      }
      if (eof) {
        resolved.stdin.end();
      }
      respond(true, {
        status: "running",
        sessionId,
        bytes: data.length,
        eof,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "terminal.session.sendKeys": async ({ params, respond }) => {
    const sessionId = resolveSessionId(params);
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    const resolved = resolveWritableSession(sessionId);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const { data, warnings } = encodeKeySequence({
      keys: Array.isArray(params.keys) ? (params.keys as string[]) : undefined,
      hex: Array.isArray(params.hex) ? (params.hex as string[]) : undefined,
      literal: typeof params.literal === "string" ? params.literal : undefined,
    });
    if (!data) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "No key data provided."));
      return;
    }
    try {
      await writeStdin(resolved.stdin, data);
      emitOperatorInput(sessionId, data);
      respond(true, {
        status: "running",
        sessionId,
        bytes: data.length,
        warnings,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "terminal.session.submit": async ({ params, respond }) => {
    const sessionId = resolveSessionId(params);
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    const resolved = resolveWritableSession(sessionId);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const prefix = typeof params.data === "string" ? params.data : "";
    const data = `${prefix}\r`;
    try {
      await writeStdin(resolved.stdin, data);
      emitOperatorInput(sessionId, data);
      respond(true, {
        status: "running",
        sessionId,
        bytes: data.length,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "terminal.session.paste": async ({ params, respond }) => {
    const sessionId = resolveSessionId(params);
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    const resolved = resolveWritableSession(sessionId);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const text = typeof params.text === "string" ? params.text : "";
    const payload = encodePaste(text, params.bracketed !== false);
    if (!payload) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "No paste text provided."));
      return;
    }
    try {
      await writeStdin(resolved.stdin, payload);
      emitOperatorInput(sessionId, payload);
      respond(true, {
        status: "running",
        sessionId,
        chars: text.length,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "terminal.session.resize": ({ params, respond }) => {
    const sessionId = resolveSessionId(params);
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    const session = getSession(sessionId);
    if (!session) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `No active session found for ${sessionId}`),
      );
      return;
    }
    if (!session.backgrounded) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Session ${sessionId} is not backgrounded.`),
      );
      return;
    }
    const cols = parseDimension(params.cols);
    const rows = parseDimension(params.rows);
    if (cols <= 0 || rows <= 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "resize requires positive numeric cols and rows"),
      );
      return;
    }
    const resized = getProcessSupervisor().resize(session.id, cols, rows);
    if (!resized) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Session ${sessionId} does not support resize.`),
      );
      return;
    }
    respond(true, {
      status: "running",
      sessionId,
      cols,
      rows,
    });
  },
};
