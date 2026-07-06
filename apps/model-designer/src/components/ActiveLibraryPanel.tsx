import { RemoteModelDBClient as RClient } from '@mode-db/sdk';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { seedDefaultWorkspaceRecords } from '../bootstrap/seed-workspace-rows.js';
import {
  getSessionToken,
  getStoredHost,
  getStoredPort,
  getStoredToken,
  persistLastLibrary,
} from '../config/connection-prefs.js';
import { FIXED_MODEL_DESIGNER_DATABASE } from '../config/fixed-database.js';
import { useDesigner } from '../context/designer-context.js';
import {
  formatLibraryLabel,
  getLibraryByCode,
  listLibraryRegistry,
  mergeLibraryRegistryWithDbNames,
  updateLibraryMetadata,
} from '../sync/library-registry.js';
import {
  importEngineCatalogIntoDesignerDb,
  readBusinessCatalog,
} from '../sync/engine-catalog-import.js';
import type { LibraryRegistryRecord } from '../types/library-registry.js';
import { DesignerSelect } from './base/designer-select.js';
import { LibraryRegistryForm, type LibraryRegistryFormHandle } from './LibraryRegistryForm.js';

/** 已连接画布时，在设置中维护当前逻辑库基本信息。 */
export function ActiveLibraryPanel(props: { onLibrarySwitched?: () => void }): ReactElement | null {
  const { i18n, config, data, asyncOps } = useDesigner();
  const [, bump] = useState(0);
  const [recordId, setRecordId] = useState('');
  const [name, setName] = useState<Record<string, string>>({});
  const [description, setDescription] = useState<Record<string, string>>({});
  const [libraries, setLibraries] = useState<readonly LibraryRegistryRecord[]>([]);
  const [loadingLibraries, setLoadingLibraries] = useState(false);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const formRef = useRef<LibraryRegistryFormHandle>(null);
  const pulledOnOpenRef = useRef(false);

  const code = config.activeLibraryName;
  const client = config.remoteClient;
  const busy = saving || switching || loadingLibraries;

  const refreshLibraries = useCallback(async (): Promise<void> => {
    if (!client) {
      setLibraries([]);
      return;
    }
    setLoadingLibraries(true);
    try {
      const host = getStoredHost('127.0.0.1');
      const port = getStoredPort(9090);
      const token = getSessionToken() ?? getStoredToken('');
      const dbs = await RClient.listDatabases({ host, port, token });
      const dbNames = dbs
        .map((db) => db.name)
        .filter((name) => name && name !== FIXED_MODEL_DESIGNER_DATABASE);
      const registry = await listLibraryRegistry(client);
      setLibraries(mergeLibraryRegistryWithDbNames(dbNames, registry));
    } catch {
      setLibraries([]);
    } finally {
      setLoadingLibraries(false);
    }
  }, [client]);

  const load = useCallback(async (): Promise<void> => {
    if (!client || !code) {
      setRecordId('');
      setName({});
      setDescription({});
      return;
    }
    const rec = await getLibraryByCode(client, code);
    if (!rec) {
      setRecordId('');
      setName(config.activeLibraryNameI18n ? { ...config.activeLibraryNameI18n } : {});
      setDescription({});
      return;
    }
    setRecordId(rec.id);
    setName({ ...rec.name });
    setDescription({ ...rec.description });
    bump((n) => n + 1);
  }, [client, code, config]);

  const pullAndLoadLibrary = useCallback(
    async (libraryCode: string): Promise<void> => {
      if (!client || !libraryCode) {
        return;
      }
      const host = getStoredHost('127.0.0.1');
      const port = getStoredPort(9090);
      const token = getSessionToken() ?? getStoredToken('');
      await seedDefaultWorkspaceRecords(client, libraryCode);
      const catalog = await readBusinessCatalog({
        host,
        port,
        token,
        businessDb: libraryCode,
      });
      await importEngineCatalogIntoDesignerDb(client, libraryCode, catalog);
      await data.loadLibraryCanvas(client, libraryCode, catalog);
    },
    [client, data],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void refreshLibraries();
  }, [refreshLibraries]);

  useEffect(() => {
    if (!client || !code || pulledOnOpenRef.current || asyncOps.isBusy) {
      return;
    }
    pulledOnOpenRef.current = true;
    void asyncOps
      .run('pull', () => pullAndLoadLibrary(code), { detail: code })
      .catch(() => {
        /* 失败状态由全局通知处理，设置面板不额外打断用户。 */
      });
  }, [asyncOps, client, code, pullAndLoadLibrary]);

  if (!code) {
    return null;
  }

  const switchLibrary = async (nextCode: string): Promise<void> => {
    if (!client || !nextCode || nextCode === code || switching || asyncOps.isBusy) {
      return;
    }
    setSwitching(true);
    setSaveMsg(null);
    try {
      await asyncOps.run(
        'loadCanvas',
        async () => {
          await pullAndLoadLibrary(nextCode);
          const rec = await getLibraryByCode(client, nextCode);
          config.setActiveLibraryName(nextCode);
          config.setActiveLibraryMeta(rec?.name ?? null);
          setRecordId(rec?.id ?? '');
          setName(rec ? { ...rec.name } : {});
          setDescription(rec ? { ...rec.description } : {});
          persistLastLibrary(nextCode);
          props.onLibrarySwitched?.();
        },
        { detail: nextCode },
      );
      await refreshLibraries();
    } catch {
      setSaveMsg(i18n.t('errors', 'librarySaveFailed'));
    } finally {
      setSwitching(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!client || !code || saving || switching) {
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const latest = formRef.current?.flush() ?? { name, description };
      setName({ ...latest.name });
      setDescription({ ...latest.description });
      const next = await updateLibraryMetadata(client, { id: recordId, code }, latest);
      setRecordId(next.id);
      setName({ ...next.name });
      setDescription({ ...next.description });
      config.setActiveLibraryMeta(next.name);
      setSaveMsg(i18n.t('ui', 'librarySaveDone'));
      await refreshLibraries();
    } catch {
      setSaveMsg(i18n.t('errors', 'librarySaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="designer-settings-row"
      style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}
    >
      <span className="designer-panel-section-title" style={{ margin: 0 }}>
        {i18n.t('ui', 'libraryDetailsTitle')}
      </span>
      <p style={{ fontSize: 12, color: 'var(--designer-text-soft)', margin: 0 }}>
        {i18n.t('ui', 'libraryDetailsHint')}
      </p>
      <label className="designer-field">
        <span className="designer-field-label">{i18n.t('ui', 'libraryCode')}</span>
        <DesignerSelect
          searchable
          value={code}
          disabled={busy || asyncOps.isBusy}
          placeholder={i18n.t('ui', 'libraryCodePlaceholder')}
          searchPlaceholder={i18n.t('ui', 'i18nPickLocale')}
          emptyLabel={i18n.t('ui', 'libraryCodePlaceholder')}
          options={libraries.map((rec) => ({
            value: rec.code,
            label: formatLibraryLabel(rec, i18n.locale),
          }))}
          onChange={(next) => void switchLibrary(next)}
        />
      </label>
      <LibraryRegistryForm
        ref={formRef}
        code={code}
        codeReadOnly
        showCode={false}
        name={name}
        description={description}
        disabled={saving || switching}
        codeLabel={i18n.t('ui', 'libraryCode')}
        codePlaceholder={i18n.t('ui', 'libraryCodePlaceholder')}
        codeInvalidHint={i18n.t('ui', 'nameInvalidFormat')}
        displayNameLabel={i18n.t('ui', 'libraryDisplayNameI18n')}
        descriptionLabel={i18n.t('ui', 'libraryDescriptionI18n')}
        pickLocaleLabel={i18n.t('ui', 'i18nPickLocale')}
        addRowHint={i18n.t('ui', 'i18nAddLocaleFill')}
        onCodeChange={() => {}}
        onNameCommit={setName}
        onDescriptionCommit={setDescription}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          className="designer-btn designer-btn-primary"
          disabled={saving || switching}
          onClick={() => void save()}
        >
          {saving || switching ? i18n.t('ui', 'librarySaving') : i18n.t('ui', 'librarySave')}
        </button>
        {saveMsg ? (
          <span style={{ fontSize: 12, color: 'var(--designer-text-soft)' }}>{saveMsg}</span>
        ) : null}
      </div>
    </div>
  );
}
