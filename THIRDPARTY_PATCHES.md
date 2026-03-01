# Third-party Patches

This document tracks modifications made to third-party code included in this repository.

## OpenClaw (`thirdparty/openclaw`)

**Source**: https://github.com/openclaw/openclaw
**Version**: Snapshot as of 2026-03-01

### Patch #1: Fix tool event payload stripping for WS clients

**File**: `src/gateway/server-chat.ts`
**Lines**: 434-444

#### Problem

When `verboseLevel !== "full"`, the OpenClaw gateway was stripping `result` and `partialResult` fields from tool events before broadcasting to **all** recipients, including WebSocket clients like TGClaw.

TGClaw's virtual terminal feature (`src/renderer/chat.js`) relies on these fields to:
- Get `sessionId` and `tail` from `partialResult` during `update` phase
- Get `sessionId`, `status`, `exitCode`, and final output from `result` during `result` phase

Without these fields, TGClaw could only receive the `start` phase, causing virtual terminals to appear "stuck" with no output or exit status.

#### Solution

Changed line 443 from:
```typescript
broadcastToConnIds("agent", toolPayload, recipients);
```

To:
```typescript
broadcastToConnIds("agent", agentPayload, recipients);
```

This ensures:
- **WS clients** (registered with tool-events capability) receive the **full** `agentPayload` including `result`/`partialResult`
- **Messaging surfaces** (Telegram, Discord, etc.) via `nodeSendToSession` still receive the stripped `toolPayload` as before

This aligns with the original code comment intent:
> "The verbose setting only controls whether tool details are sent as channel messages to messaging surfaces (Telegram, Discord, etc.)"

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
