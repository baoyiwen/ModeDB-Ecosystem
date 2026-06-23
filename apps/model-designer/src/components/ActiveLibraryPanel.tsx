import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import { getLibraryByCode, updateLibraryMetadata } from '../sync/library-registry.js';
import { LibraryRegistryForm } from './LibraryRegistryForm.js';

/** 已连接画布时，在设置中维护当前逻辑库基本信息。 */
export function ActiveLibraryPanel(): ReactElement | null {
  const { i18n, config } = useDesigner();
  const [, bump] = useState(0);
  const [recordId, setRecordId] = useState('');
  const [name, setName] = useState<Record<string, string>>({});
  const [description, setDescription] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const code = config.activeLibraryName;
  const client = config.remoteClient;

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
      setName({ en: code, zh: code, ja: code });
      setDescription({});
      return;
    }
    setRecordId(rec.id);
    setName({ ...rec.name });
    setDescription({ ...rec.description });
    config.setActiveLibraryMeta(rec.name);
    bump((n) => n + 1);
  }, [client, code, config]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!code) {
    return null;
  }

  const save = async (): Promise<void> => {
    if (!client || !code || saving) {
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const next = await updateLibraryMetadata(
        client,
        { id: recordId, code },
        { name, description },
      );
      setRecordId(next.id);
      setName({ ...next.name });
      setDescription({ ...next.description });
      config.setActiveLibraryMeta(next.name);
      setSaveMsg(i18n.t('ui', 'librarySaveDone'));
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
      <LibraryRegistryForm
        code={code}
        codeReadOnly
        name={name}
        description={description}
        disabled={saving}
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
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? i18n.t('ui', 'librarySaving') : i18n.t('ui', 'librarySave')}
        </button>
        {saveMsg ? (
          <span style={{ fontSize: 12, color: 'var(--designer-text-soft)' }}>{saveMsg}</span>
        ) : null}
      </div>
    </div>
  );
}
