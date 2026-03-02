import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessSession } from "../../agents/bash-process-registry.js";
import { terminalSessionHandlers } from "./terminal-sessions.js";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getFinishedSession: vi.fn(),
}));

vi.mock("../../agents/bash-process-registry.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../agents/bash-process-registry.js")>(
      "../../agents/bash-process-registry.js",
    );
  return {
    ...actual,
    getSession: mocks.getSession,
    getFinishedSession: mocks.getFinishedSession,
  };
});

function makeRunningSession(overrides?: Partial<ProcessSession>): ProcessSession {
  return {
    id: "sess-1",
    command: "claude",
    startedAt: 1_700_000_000_000,
    cwd: "/tmp/workspace",
    maxOutputChars: 30_000,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "sanitized aggregated",
    tail: "sanitized tail",
    rawAggregated: "",
    rawTail: "",
    outputCursor: 0,
    exited: false,
    truncated: false,
    backgrounded: true,
    ...overrides,
  };
}

function runAttach(sessionId = "sess-1") {
  const respond = vi.fn();
  const attachTerminalSession = vi.fn();
  terminalSessionHandlers["terminal.session.attach"]({
    params: { sessionId } as never,
    respond,
    context: { attachTerminalSession } as never,
    client: { connId: "conn-1" } as never,
  });
  return { respond, attachTerminalSession };
}

describe("terminal.session.attach recent output selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers rawAggregated when available", () => {
    mocks.getSession.mockReturnValue(
      makeRunningSession({
        rawAggregated: "full raw transcript",
        rawTail: "truncated raw tail",
        tail: "sanitized tail",
      }),
    );

    const { respond } = runAttach();
    const [ok, payload] = respond.mock.calls[0] ?? [];

    expect(ok).toBe(true);
    expect(payload?.recentOutput).toBe("full raw transcript");
  });

  it("falls back to rawTail when rawAggregated is empty", () => {
    mocks.getSession.mockReturnValue(
      makeRunningSession({
        rawAggregated: "",
        rawTail: "raw tail",
        tail: "sanitized tail",
      }),
    );

    const { respond } = runAttach();
    const [ok, payload] = respond.mock.calls[0] ?? [];

    expect(ok).toBe(true);
    expect(payload?.recentOutput).toBe("raw tail");
  });

  it("falls back to sanitized output when no raw stream exists", () => {
    mocks.getSession.mockReturnValue(
      makeRunningSession({
        rawAggregated: "",
        rawTail: "",
        tail: "sanitized tail",
        aggregated: "sanitized aggregated",
      }),
    );

    const { respond } = runAttach();
    const [ok, payload] = respond.mock.calls[0] ?? [];

    expect(ok).toBe(true);
    expect(payload?.recentOutput).toBe("sanitized tail");
  });
});
