/** Bound anonymous rejection writes and yield between durable transactions for local IPC. */
import type { DataSecurityEvent } from '@mode-db/shared';
import type { SecurityRegistry } from './security-registry.js';
import { SecurityError } from './security-errors.js';

export const MAX_PUBLIC_REJECTION_AUDITS = 64;
type Job = { event: DataSecurityEvent; resolve: () => void; reject: (error: unknown) => void };
const queues = new WeakMap<SecurityRegistry, { jobs: Job[]; scheduled: boolean }>();

/** One shared FIFO per instance for registration and login. No success before durable audit.
 * Capacity/storage errors remain fail-closed; local maintenance never enters this queue. */
export function recordPublicRejection(
  registry: SecurityRegistry,
  event: DataSecurityEvent,
): Promise<void> {
  let queue = queues.get(registry);
  if (!queue) {
    queue = { jobs: [], scheduled: false };
    queues.set(registry, queue);
  }
  if (queue.jobs.length >= MAX_PUBLIC_REJECTION_AUDITS) {
    return Promise.reject(new SecurityError('SECURITY_AUDIT_CAPACITY'));
  }
  const state = queue;
  const result = new Promise<void>((resolve, reject) => {
    state.jobs.push({ event: structuredClone(event), resolve, reject });
  });
  if (!state.scheduled) {
    state.scheduled = true;
    const next = () => {
      const job = state.jobs[0];
      if (!job) {
        state.scheduled = false;
        return;
      }
      try {
        registry.recordSecurityEvent(job.event);
        job.resolve();
      } catch (error) {
        job.reject(error);
      } finally {
        state.jobs.shift();
        // A newly scheduled immediate runs in a later iteration, allowing pipe I/O in between.
        setImmediate(next);
      }
    };
    setImmediate(next);
  }
  return result;
}
