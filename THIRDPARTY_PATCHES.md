# Third-party Patches

This document tracks modifications made to third-party code included in this repository.

## OpenClaw (`thirdparty/openclaw`)

**Source**: https://github.com/openclaw/openclaw  
**Version**: Snapshot as of 2026-03-01

### Patch #1: Fix tool event payload stripping for WS clients

**File**: `src/gateway/server-chat.ts`  
**Lines**: 434-444

#### Problem

When `verboseLevel !== "full"`, the OpenClaw gateway was stripping `result` and `partialResult` fields from tool events before broadcasting to all recipients, including WebSocket clients like TGClaw.

TGClaw virtual terminal rendering (`src/renderer/chat.js`) relies on these fields to:
- read `sessionId` and `tail` during `update`
- read `sessionId`, `status`, `exitCode`, and final output during `result`

Without these fields, TGClaw received only `start` and showed a stuck virtual terminal.

#### Solution

Changed:
```typescript
broadcastToConnIds("agent", toolPayload, recipients);
```

To:
```typescript
broadcastToConnIds("agent", agentPayload, recipients);
```

This preserves full payloads for WS clients while keeping stripped tool messages for messaging surfaces.

#### Diff

```diff
@@ -434,11 +434,13 @@ export function createAgentEventHandler({
     if (isToolEvent) {
       // Always broadcast tool events to registered WS recipients with
       // tool-events capability, regardless of verboseLevel. The verbose
       // setting only controls whether tool details are sent as channel
       // messages to messaging surfaces (Telegram, Discord, etc.).
+      // WS clients (like TGClaw) receive full payload so they can render
+      // virtual terminal output from result/partialResult fields.
       const recipients = toolEventRecipients.get(evt.runId);
       if (recipients && recipients.size > 0) {
-        broadcastToConnIds("agent", toolPayload, recipients);
+        broadcastToConnIds("agent", agentPayload, recipients);
       }
     } else {
```

### Patch #2: Preserve raw PTY tail for terminal replay consumers

**Files**:
- `src/agents/bash-process-registry.ts`
- `src/agents/bash-tools.exec-runtime.ts`
- `src/agents/bash-tools.exec-types.ts`
- `src/agents/bash-tools.exec.ts`

#### Problem

`exec` tool updates sanitize output via `sanitizeBinaryOutput`, which removes control bytes (including ESC).  
For PTY/TUI programs (for example Claude Code), this turns ANSI streams into fragments like `[1C` and `[?2026h`.

WS clients replaying `details.tail` into xterm then render those fragments literally, causing garbled terminal UI.

#### Solution

Added a parallel `rawTail` channel for terminal replay:
- keep existing sanitized `tail`/`aggregated` behavior for chat/log output
- track PTY raw output in session state (`rawAggregated`/`rawTail`)
- include `rawTail` in running updates and completion details

This cleanly separates:
- human/chat text channel: sanitized output
- terminal replay channel: raw PTY-compatible bytes

#### Notes

`rawTail` is optional and backward-compatible. Consumers that only read `tail` continue to work.

### Patch #3: Add gateway-native terminal session control plane (attach/write/resize/events)

**Files**:
- `src/agents/process-session-events.ts`
- `src/agents/bash-tools.exec-runtime.ts`
- `src/agents/bash-process-registry.ts`
- `src/agents/bash-tools.process.ts`
- `src/process/supervisor/types.ts`
- `src/process/supervisor/supervisor.ts`
- `src/process/supervisor/adapters/pty.ts`
- `src/gateway/server-terminal-sessions.ts`
- `src/gateway/server-methods/terminal-sessions.ts`
- `src/gateway/server-methods.ts`
- `src/gateway/server-methods-list.ts`
- `src/gateway/method-scopes.ts`
- `src/gateway/server-methods/types.ts`
- `src/gateway/server/ws-connection.ts`
- `src/gateway/server.impl.ts`
- `src/gateway/server-close.ts`

#### Problem

TGClaw previously depended on tool-event replay (`exec`/`process`) to emulate terminal output.
This caused divergence from real interactive terminal behavior:
- startup text formatting differed from manual launch
- command wrapper text could leak into terminal view
- no real bidirectional operator interaction path to the live OpenClaw PTY session

#### Solution

Added a dedicated terminal-session control plane in OpenClaw gateway:

- New RPC methods:
  - `terminal.session.attach`
  - `terminal.session.detach`
  - `terminal.session.write`
  - `terminal.session.submit`
  - `terminal.session.paste`
  - `terminal.session.sendKeys`
  - `terminal.session.resize`
- New events:
  - `terminal.session.output`
  - `terminal.session.input`
  - `terminal.session.exit`
- Added process-session event bus so exec/process layer can publish live output/input/exit.
- Added PTY resize support through process supervisor so remote terminals can react to xterm resize.
- Added per-connection session subscription registry and automatic cleanup on WebSocket disconnect.

This provides a first-class streaming API for terminal consumers while preserving legacy tool-event behavior.

### Patch #4: Make `process submit` send payload data before CR

**File**: `src/agents/bash-tools.process.ts`

#### Problem

`process` tool action `submit` previously ignored `data` and always wrote only `"\r"`.
This made agent automation appear to "submit prompts" while the underlying CLI session only received Enter.

#### Solution

Changed `submit` write behavior from:
- `"\r"` only

to:
- `${data}\r` (with empty-string fallback)

Input event publishing now mirrors the exact bytes written.

#### Validation

- Added unit coverage in:
  - `src/agents/bash-tools.process.send-keys.test.ts`
- New test asserts `submit` includes provided text before Enter.

### Patch #5: Reuse running interactive PTY sessions for repeated `exec` starts

**Files**:
- `src/agents/bash-tools.exec.ts`
- `src/agents/bash-tools.exec.reuse.test.ts`

#### Problem

Repeated agent requests to start interactive coding CLIs (for example `claude`) created new background sessions each time, fragmenting human/agent collaboration and losing continuity.

#### Solution

Added guarded reuse logic in `exec`:
- Applies only when all conditions match:
  - PTY mode
  - background/yield continuation requested
  - command is a known interactive CLI (`claude`, `codex`, `opencode`)
  - same `cwd`
  - same `scopeKey`
  - existing running background session
- Reuses the newest matching running session and returns it as `status: "running"` instead of spawning a new process.

#### Validation

- Added targeted unit tests in:
  - `src/agents/bash-tools.exec.reuse.test.ts`
