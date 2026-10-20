import type { ManagementBackupInfo } from '@mode-db/sdk';
import type { LibraryRegistryRecord } from '../types/library-registry.js';
import { formatLibraryLabel, mergeLibraryRegistryWithDbNames } from '../sync/library-registry.js';

export function formatBackupTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function defaultBackupName(database: string, date = new Date()): string {
  const timestamp = formatBackupTime(date).replace(/[: ]/g, '-');
  return `${database.slice(0, 119 - timestamp.length)}_${timestamp}`;
}

export function backupDisplayName(backup: ManagementBackupInfo): string {
  return backup.name?.trim() || defaultBackupName(backup.database, new Date(backup.createdAt));
}

export function formatBackupBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface BackupGroup {
  readonly code: string;
  readonly label: string;
  readonly backups: readonly ManagementBackupInfo[];
}

export function groupBackups(
  backups: readonly ManagementBackupInfo[],
  registry: readonly LibraryRegistryRecord[],
  locale: string,
  activeDatabase: string,
): BackupGroup[] {
  const codes = new Set([
    activeDatabase,
    ...registry.map((item) => item.code),
    ...backups.map((item) => item.database),
  ]);
  const records = mergeLibraryRegistryWithDbNames([...codes], registry);
  return [...codes]
    .filter(Boolean)
    .sort((a, b) => (a === activeDatabase ? -1 : b === activeDatabase ? 1 : a.localeCompare(b)))
    .map((code) => ({
      code,
      label: formatLibraryLabel(
        records.find((item) => item.code === code) ?? { code, name: {} },
        locale,
      ),
      backups: backups
        .filter((item) => item.database === code)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }));
}
