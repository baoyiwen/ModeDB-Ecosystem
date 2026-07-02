/**
 * Minimal RFC4180-ish CSV line parser (no multiline quoted fields).
 */

export function parseCsvLine(line: string, delimiter = ','): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function coerceCsvCell(raw: string): unknown {
  const t = raw.trim();
  if (t === '') {
    return null;
  }
  if (t === 'true') {
    return true;
  }
  if (t === 'false') {
    return false;
  }
  const n = Number(t);
  if (!Number.isNaN(n) && t !== '') {
    return n;
  }
  return t;
}

export function rowFromCsvLine(
  headers: readonly string[],
  line: string,
  delimiter: string,
): Record<string, unknown> {
  const cells = parseCsvLine(line, delimiter);
  const row: Record<string, unknown> = {};
  for (let i = 0; i < headers.length; i++) {
    row[headers[i]!] = coerceCsvCell(cells[i] ?? '');
  }
  return row;
}
