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
