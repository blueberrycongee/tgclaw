export type ProcessSessionOutputEvent = {
  type: "output";
  sessionId: string;
  data: string;
  stream: "stdout" | "stderr";
  cursor: number;
  ts: number;
};

export type ProcessSessionInputEvent = {
  type: "input";
  sessionId: string;
  data: string;
  actor: "agent" | "operator";
  ts: number;
};

export type ProcessSessionExitEvent = {
  type: "exit";
  sessionId: string;
  status: "completed" | "failed" | "killed";
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  ts: number;
};

export type ProcessSessionEvent =
  | ProcessSessionOutputEvent
  | ProcessSessionInputEvent
  | ProcessSessionExitEvent;

export type ProcessSessionEventListener = (event: ProcessSessionEvent) => void;

const listeners = new Set<ProcessSessionEventListener>();

export function subscribeProcessSessionEvents(listener: ProcessSessionEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishProcessSessionEvent(event: ProcessSessionEvent): void {
  if (!event || !event.sessionId) {
    return;
  }
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener failures so one consumer cannot break the stream.
    }
  }
}

export function resetProcessSessionEventsForTests(): void {
  listeners.clear();
}
