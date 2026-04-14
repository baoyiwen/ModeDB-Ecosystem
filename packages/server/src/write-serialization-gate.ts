import { EngineLogger } from '@mode-db/common';

/**
 * Per-atlas async queue so mutating RPCs never overlap on the same physical atlas.
 * When access logging is on, logs **`Write block`** / **`queueLength`** to **`access.log`**.
 */
export class WriteSerializationGate {
  private readonly tails = new Map<string, Promise<unknown>>();
  private backlog = 0;

  runExclusive<T>(atlas: string, fn: () => Promise<T>): Promise<T> {
    this.backlog++;
    const queueLength = this.backlog;
    const prev = this.tails.get(atlas) ?? Promise.resolve();
    const result = prev.then(async () => {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        const ms = performance.now() - t0;
        this.backlog = Math.max(0, this.backlog - 1);
        if (EngineLogger.instance.isAccessLogEnabled()) {
          EngineLogger.instance.accessWriteGateExclusive(ms, queueLength, atlas);
        }
      }
    });
    this.tails.set(
      atlas,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
