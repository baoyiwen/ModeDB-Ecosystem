import type { Readable } from 'node:stream';

const BULK_MAGIC = Buffer.from('MDBC', 'ascii');

export interface BulkStreamOptions {
  readonly perFrameMaxBytes: number;
  readonly maxInFlight: number;
  readonly maxStreamBytes: number;
}

const defaultBulkOpts: BulkStreamOptions = {
  perFrameMaxBytes: 16 * 1024 * 1024,
  maxInFlight: 4,
  maxStreamBytes: 512 * 1024 * 1024,
};

/**
 * Reads **`MDBC` + u32be length + payload** frames from a **Readable** body.
 * Pauses the readable while **`onFrame`** backlog reaches **`maxInFlight`**.
 */
export async function consumeFramedBulkStreamFromReadable(
  readable: Readable,
  onFrame: (payload: Buffer) => Promise<void>,
  opts: Partial<BulkStreamOptions> = {},
): Promise<{ readonly frames: number }> {
  const o = { ...defaultBulkOpts, ...opts };
  let buffer = Buffer.alloc(0);
  let streamTotal = 0;
  let frames = 0;
  const pending: Promise<void>[] = [];
  let inFlight = 0;

  const waitSlot = async (): Promise<void> => {
    while (inFlight >= o.maxInFlight) {
      readable.pause();
      await Promise.race(pending);
      readable.resume();
    }
  };

  for await (const chunk of readable) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    streamTotal += b.length;
    if (streamTotal > o.maxStreamBytes) {
      throw new Error(`Bulk stream exceeded maxStreamBytes (${o.maxStreamBytes}).`);
    }
    buffer = buffer.length === 0 ? b : Buffer.concat([buffer, b]);

    while (buffer.length >= 8) {
      if (!buffer.subarray(0, 4).equals(BULK_MAGIC)) {
        throw new Error('Bulk stream: expected MDBC frame magic.');
      }
      const len = buffer.readUInt32BE(4);
      if (len > o.perFrameMaxBytes) {
        throw new Error(`Bulk frame too large (>${o.perFrameMaxBytes}).`);
      }
      if (buffer.length < 8 + len) {
        break;
      }
      const payload = buffer.subarray(8, 8 + len);
      buffer = buffer.subarray(8 + len);
      frames++;
      await waitSlot();
      inFlight++;
      const p = onFrame(Buffer.from(payload)).finally(() => {
        inFlight--;
        const i = pending.indexOf(p);
        if (i >= 0) {
          pending.splice(i, 1);
        }
      });
      pending.push(p);
    }
  }

  await Promise.all(pending);
  if (buffer.length > 0) {
    throw new Error('Bulk stream: incomplete trailing frame.');
  }
  return { frames };
}

/**
 * Accumulate a single HTTP body with a **total size cap** and occasional **pause**
 * when buffered data exceeds **`highWaterMark`**.
 */
export async function readBodyWithBackpressure(
  raw: Readable,
  maxTotalBytes: number,
  highWaterMark: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let bufferedSinceYield = 0;
  for await (const chunk of raw) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxTotalBytes) {
      throw new Error(`HTTP body exceeds maxTotalBytes (${maxTotalBytes}).`);
    }
    chunks.push(b);
    bufferedSinceYield += b.length;
    if (bufferedSinceYield >= highWaterMark) {
      raw.pause();
      bufferedSinceYield = 0;
      await new Promise<void>((r) => setImmediate(r));
      raw.resume();
    }
  }
  return Buffer.concat(chunks, total);
}
