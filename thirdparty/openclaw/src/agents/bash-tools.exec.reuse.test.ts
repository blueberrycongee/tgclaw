import { expect, test } from "vitest";
import {
  findReusableInteractiveExecSession,
  isInteractiveReuseEligible,
} from "./bash-tools.exec.js";

const BASE_SESSION = {
  id: "session-a",
  command: "claude",
  cwd: "/tmp/work",
  scopeKey: "scope-a",
  startedAt: 1_000,
  exited: false,
  pid: 1234,
  tail: "",
  rawTail: "",
};

test("returns null when pty/background eligibility is missing", () => {
  expect(
    findReusableInteractiveExecSession({
      sessions: [BASE_SESSION],
      command: "claude",
      workdir: "/tmp/work",
      scopeKey: "scope-a",
      usePty: false,
      backgroundEligible: true,
    }),
  ).toBeNull();

  expect(
    findReusableInteractiveExecSession({
      sessions: [BASE_SESSION],
      command: "claude",
      workdir: "/tmp/work",
      scopeKey: "scope-a",
      usePty: true,
      backgroundEligible: false,
    }),
  ).toBeNull();
});

test("treats default-yield background continuation as reuse eligible", () => {
  expect(isInteractiveReuseEligible({ allowBackground: true, yieldWindow: 10_000 })).toBe(true);
  expect(isInteractiveReuseEligible({ allowBackground: true, yieldWindow: 0 })).toBe(true);
  expect(isInteractiveReuseEligible({ allowBackground: false, yieldWindow: 10_000 })).toBe(false);
  expect(isInteractiveReuseEligible({ allowBackground: true, yieldWindow: null })).toBe(false);
});

test("finds newest running interactive session for same command/cwd/scope", () => {
  const older = { ...BASE_SESSION, id: "old", startedAt: 1_000 };
  const newer = { ...BASE_SESSION, id: "new", startedAt: 2_000 };
  const reused = findReusableInteractiveExecSession({
    sessions: [older, newer],
    command: "claude",
    workdir: "/tmp/work",
    scopeKey: "scope-a",
    usePty: true,
    backgroundEligible: true,
  });
  expect(reused?.id).toBe("new");
});

test("ignores exited/different command/cwd/scope sessions", () => {
  const sessions = [
    { ...BASE_SESSION, id: "exited", exited: true, startedAt: 5_000 },
    { ...BASE_SESSION, id: "wrong-command", command: "claude -p hi", startedAt: 4_000 },
    { ...BASE_SESSION, id: "wrong-cwd", cwd: "/tmp/other", startedAt: 3_000 },
    { ...BASE_SESSION, id: "wrong-scope", scopeKey: "scope-b", startedAt: 2_000 },
  ];
  const reused = findReusableInteractiveExecSession({
    sessions,
    command: "claude",
    workdir: "/tmp/work",
    scopeKey: "scope-a",
    usePty: true,
    backgroundEligible: true,
  });
  expect(reused).toBeNull();
});
