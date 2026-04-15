/**
 * Query result cache: keyed by fingerprint; invalidated per model on writes.
 */
export class SmartCache {
  private readonly entries = new Map<
    string,
    { readonly deps: ReadonlySet<string>; readonly rows: unknown; readonly terminalModel: string }
  >();

  get(key: string): { readonly rows: unknown; readonly terminalModel: string } | undefined {
    const e = this.entries.get(key);
    if (!e) {
      return undefined;
    }
    return { rows: e.rows, terminalModel: e.terminalModel };
  }

  set(key: string, deps: Iterable<string>, rows: unknown, terminalModel: string): void {
    this.entries.set(key, { deps: new Set(deps), rows, terminalModel });
  }

  /** Remove every entry that depends on `modelName` (origin, hop source/target, terminal). */
  invalidateModel(modelName: string): void {
    for (const [k, v] of this.entries) {
      if (v.deps.has(modelName)) {
        this.entries.delete(k);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  /** @internal */
  _size(): number {
    return this.entries.size;
  }
}
