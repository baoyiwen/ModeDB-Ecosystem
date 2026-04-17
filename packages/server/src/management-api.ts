import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ManagementDatabaseInfo } from '@mode-db/shared';

/**
 * 扫描 **`workspaceRoot`** 下已存在的逻辑库：嵌套 **`&lt;name&gt;/atlas.mld`** 或 workspace-flat **`&lt;name&gt;.mld`**。
 */
export function scanWorkspaceDatabases(workspaceRoot: string): ManagementDatabaseInfo[] {
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) {
    return [];
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const out: ManagementDatabaseInfo[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) {
      continue;
    }
    if (e.isDirectory()) {
      const nested = join(root, e.name, 'atlas.mld');
      if (existsSync(nested)) {
        const st = statSync(nested);
        out.push({
          name: e.name,
          status: 'active',
          createTime: new Date(st.mtimeMs).toISOString(),
          bytesUsed: st.size,
        });
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.mld')) {
      const base = e.name.replace(/\.mld$/i, '');
      const st = statSync(join(root, e.name));
      out.push({
        name: base,
        status: 'active',
        createTime: new Date(st.mtimeMs).toISOString(),
        bytesUsed: st.size,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
