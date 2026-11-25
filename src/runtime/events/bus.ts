import { RuntimeEventSchema, type RuntimeEvent } from "../../shared/contracts/index.js";

export type EventListener = (event: RuntimeEvent) => void;

/**
 * In-process event bus for live UI updates. Durable state lives in SQLite;
 * this bus is never the source of truth and a slow listener cannot block a run
 * (listener failures are isolated).
 */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: RuntimeEvent): void {
    const parsed = RuntimeEventSchema.parse(event);
    for (const listener of this.listeners) {
      try {
        listener(parsed);
      } catch {
        // A failing subscriber must not abort the run or other subscribers.
      }
    }
  }
}
