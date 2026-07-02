import type {
  IngestAdapter,
  IngestHandle,
  IngestRow,
  IngestSchema,
  IngestSource,
} from './types.js';
import { parseCsvLine, rowFromCsvLine } from './csv-parse.js';

function resolveCsvText(source: IngestSource): string {
  const inline = source.options?.content;
  if (typeof inline === 'string') {
    return inline;
  }
  throw new Error(
    'CsvIngestAdapter: provide CSV text via source.options.content (browser File reading is app-layer).',
  );
}

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.length > 0);
}

class CsvIngestHandle implements IngestHandle {
  readonly format = 'csv' as const;
  private readonly headers: readonly string[];
  private readonly dataLines: readonly string[];
  private cursor = 0;
  private closed = false;
  private readonly delimiter: string;

  constructor(headers: readonly string[], dataLines: readonly string[], delimiter: string) {
    this.headers = headers;
    this.dataLines = dataLines;
    this.delimiter = delimiter;
  }

  async sniffSchema(sampleRows = 20): Promise<IngestSchema> {
    const sample = Math.min(sampleRows, this.dataLines.length);
    const columns = this.headers.map((name) => {
      const values: unknown[] = [];
      for (let i = 0; i < sample; i++) {
        const row = rowFromCsvLine(this.headers, this.dataLines[i]!, this.delimiter);
        values.push(row[name]);
      }
      return {
        name,
        sampleValues: values,
        nullable: values.some((v) => v === null),
      };
    });
    return {
      format: 'csv',
      columns,
      rowCountEstimate: this.dataLines.length,
    };
  }

  async readChunk(size: number): Promise<readonly IngestRow[] | null> {
    if (this.closed || this.cursor >= this.dataLines.length) {
      return null;
    }
    const end = Math.min(this.cursor + size, this.dataLines.length);
    const chunk: IngestRow[] = [];
    for (let i = this.cursor; i < end; i++) {
      chunk.push(rowFromCsvLine(this.headers, this.dataLines[i]!, this.delimiter));
    }
    this.cursor = end;
    return chunk;
  }

  close(): void {
    this.closed = true;
  }
}

/** CSV ingest adapter — streaming via line cursor over in-memory text. */
export class CsvIngestAdapter implements IngestAdapter {
  readonly format = 'csv' as const;

  async open(source: IngestSource): Promise<IngestHandle> {
    if (source.format !== 'csv') {
      throw new Error(`CsvIngestAdapter: expected format "csv", got "${source.format}".`);
    }
    const delimiter =
      typeof source.options?.delimiter === 'string' && source.options.delimiter.length > 0
        ? source.options.delimiter
        : ',';
    const text = resolveCsvText(source);
    const lines = splitLines(text);
    if (lines.length === 0) {
      throw new Error('CsvIngestAdapter: empty CSV content.');
    }
    const headers = parseCsvLine(lines[0]!, delimiter).map((h) => h.trim());
    if (headers.length === 0) {
      throw new Error('CsvIngestAdapter: missing header row.');
    }
    const dataLines = lines.slice(1);
    return new CsvIngestHandle(headers, dataLines, delimiter);
  }
}

/** Singleton adapter instance. */
export const csvIngestAdapter = new CsvIngestAdapter();
