/** Kept independent of ExcelJS so catalog and preview loading stay lightweight. */
export function transferSheetName(name: string, used: Set<string>): string {
  const clean = name
    .replace(/[\x00-\x1f\\/*?:[\]]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim();
  const truncate = (text: string, size: number): string =>
    text.slice(0, size).replace(/[\uD800-\uDBFF]$/, '');
  const base = truncate(clean, 31) || 'Model';
  let result = base;
  for (let i = 2; used.has(result.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    result = `${truncate(base, 31 - suffix.length)}${suffix}`;
  }
  used.add(result.toLowerCase());
  return result;
}
