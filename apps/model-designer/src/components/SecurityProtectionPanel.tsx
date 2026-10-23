import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  securityControl,
  type SecurityControlRequest,
  type SecurityControlResult,
  type SecurityProtectionConfig,
  type SecurityProtectionState,
  type SecurityProtectionPreview,
  type SecurityMaintenanceStatus,
  type SecurityPlane,
  type SecuritySourceRule,
} from '@mode-db/sdk';
import { useDesigner } from '../context/designer-context.js';
import { getStoredHost, getStoredPort } from '../config/connection-prefs.js';

const endpoint = () => ({ host: getStoredHost('127.0.0.1'), port: getStoredPort(9090) });
const command = <T extends SecurityControlRequest>(request: T): Promise<SecurityControlResult<T>> =>
  securityControl(endpoint(), request);

/** Both panels use the same server commands as the OS-authenticated maintenance CLI. */
export function SecurityProtectionPanel({
  section,
}: {
  section: 'network' | 'keys';
}): ReactElement {
  const { i18n } = useDesigner();
  const t = (key: string) => i18n.t('ui', key);
  const [state, setState] = useState<SecurityProtectionState>();
  const [draft, setDraft] = useState<SecurityProtectionConfig>();
  const [preview, setPreview] = useState<SecurityProtectionPreview>();
  const [maintenance, setMaintenance] = useState<SecurityMaintenanceStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [rotateConfirmed, setRotateConfirmed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const failure = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : 'SECURITY_OPERATION_FAILED');
  const refresh = useCallback(
    async (replaceDraft = false) => {
      if (section === 'network') {
        const next = await command({ action: 'network.status' });
        setState(next);
        if (replaceDraft) {
          setDraft(next.config);
          setPreview(undefined);
        }
      } else setMaintenance(await command({ action: 'maintenance.status' }));
    },
    [section],
  );
  useEffect(() => {
    setError(undefined);
    void refresh(true).catch(failure);
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      if (state?.pending) void refresh().catch(failure);
    }, 5000);
    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, [refresh, state?.pending]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (reason) {
      failure(reason);
    } finally {
      setBusy(false);
    }
  };
  const change = (next: SecurityProtectionConfig) => {
    setDraft(next);
    setPreview(undefined);
  };
  const saveState = (next: SecurityProtectionState) => {
    setState(next);
    setDraft(next.config);
    setPreview(undefined);
  };
  const rules = (plane: SecurityPlane, kind: 'allow' | 'deny') => {
    if (!draft) return null;
    const entries = draft[plane][kind] ?? [];
    const update = (next: readonly SecuritySourceRule[]) =>
      change({ ...draft, [plane]: { ...draft[plane], [kind]: next } });
    return (
      <div className="security-protection-rules" key={kind}>
        <strong>{t(`securityProtection_${kind}`)}</strong>
        {entries.map((rule, index) => (
          <div className="security-protection-rule" key={index}>
            {(['id', 'source', 'expiresAt', 'reason'] as const).map((field) => (
              <label key={field}>
                <span>{t(`securityProtection_${field}`)}</span>
                <input
                  value={rule[field] ?? ''}
                  maxLength={field === 'reason' ? 240 : 128}
                  onChange={(event) =>
                    update(
                      entries.map((entry, at) =>
                        at === index
                          ? { ...entry, [field]: event.target.value || undefined }
                          : entry,
                      ),
                    )
                  }
                />
              </label>
            ))}
            <button
              type="button"
              className="designer-btn"
              onClick={() => update(entries.filter((_, at) => at !== index))}
            >
              {t('securityProtection_remove')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="designer-btn"
          onClick={() => update([...entries, { id: crypto.randomUUID(), source: '' }])}
        >
          {t('securityProtection_add')}
        </button>
      </div>
    );
  };

  return (
    <section className="security-protection-panel" aria-busy={busy}>
      <p className="security-center-note">
        {t(section === 'network' ? 'securityProtection_note' : 'securityMaintenance_note')}
      </p>
      {error ? (
        <p role="alert" className="security-center-audit-error">
          {t('securityProtection_failed')} <code>{error}</code>
        </p>
      ) : null}
      <button
        type="button"
        className="designer-btn"
        disabled={busy}
        onClick={() => void run(() => refresh(true))}
      >
        {t('securityCenterRefresh')}
      </button>
      {section === 'network' && state && draft ? (
        <>
          <p>
            {t('securityProtection_revision')}: {state.revision}
          </p>
          {state.pending ? (
            <div className="security-protection-pending" role="status">
              <p>
                {t('securityProtection_pending').replace(
                  '{seconds}',
                  String(
                    Math.max(0, Math.ceil((Date.parse(state.pending.expiresAt) - now) / 1000)),
                  ),
                )}
              </p>
              <button
                type="button"
                className="designer-btn"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    saveState(await command({ action: 'network.confirm', id: state.pending!.id })),
                  )
                }
              >
                {t('securityProtection_confirm')}
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="designer-btn"
            disabled={busy || (!state.pending && !state.previous)}
            onClick={() =>
              void run(async () =>
                saveState(await command({ action: 'network.rollback', revision: state.revision })),
              )
            }
          >
            {t('securityProtection_rollback')}
          </button>
          <fieldset disabled={busy || Boolean(state.pending)}>
            {(['data', 'management'] as const).map((plane) => (
              <fieldset key={plane}>
                <legend>{t(`securityProtection_${plane}`)}</legend>
                <label className="security-protection-checkbox">
                  <input
                    type="checkbox"
                    checked={draft[plane].allowListEnabled !== false}
                    onChange={(event) =>
                      change({
                        ...draft,
                        [plane]: { ...draft[plane], allowListEnabled: event.target.checked },
                      })
                    }
                  />
                  {t('securityProtection_allowEnabled')}
                </label>
                {draft[plane].allowListEnabled !== false && !draft[plane].allow?.length ? (
                  <p role="status">{t('securityProtection_emptyAllow')}</p>
                ) : null}
                {rules(plane, 'allow')}
                {rules(plane, 'deny')}
              </fieldset>
            ))}
            <fieldset>
              <legend>{t('securityProtection_rate')}</legend>
              <div className="security-center-audit-filter-grid">
                {(
                  [
                    'windowSeconds',
                    'dataRequests',
                    'managementRequests',
                    'principalRequests',
                    'authenticationFailures',
                    'banSeconds',
                  ] as const
                ).map((field) => (
                  <label key={field}>
                    <span>{t(`securityProtection_${field}`)}</span>
                    <input
                      type="number"
                      min={1}
                      max={field.endsWith('Seconds') ? 3600 : 100000}
                      value={draft.rate[field]}
                      onChange={(event) =>
                        change({
                          ...draft,
                          rate: { ...draft.rate, [field]: Number(event.target.value) },
                        })
                      }
                    />
                  </label>
                ))}
                <label>
                  <span>{t('securityProtection_exempt')}</span>
                  <input
                    value={draft.rate.exemptManagementSources.join(', ')}
                    onChange={(event) =>
                      change({
                        ...draft,
                        rate: {
                          ...draft.rate,
                          exemptManagementSources: event.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <label className="security-protection-checkbox">
                <input
                  type="checkbox"
                  checked={draft.rate.autoBan}
                  onChange={(event) =>
                    change({ ...draft, rate: { ...draft.rate, autoBan: event.target.checked } })
                  }
                />
                {t('securityProtection_autoBan')}
              </label>
            </fieldset>
            <button
              type="button"
              className="designer-btn"
              onClick={() =>
                void run(async () =>
                  setPreview(await command({ action: 'network.preview', config: draft })),
                )
              }
            >
              {t('securityProtection_preview')}
            </button>
            {preview ? (
              <div className="security-protection-preview" role="status">
                <p>{t('securityProtection_previewNote')}</p>
                <ul>
                  {preview.connections.map((entry, index) => (
                    <li key={index}>
                      {t(`securityProtection_${entry.plane}`)} · {entry.clientIp} ·{' '}
                      {t(
                        entry.allowed ? 'securityProtection_allowed' : 'securityProtection_denied',
                      )}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="designer-btn"
                  disabled={Date.parse(preview.expiresAt) <= now}
                  onClick={() =>
                    void run(async () =>
                      saveState(
                        await command({
                          action: 'network.apply',
                          config: draft,
                          revision: preview.revision,
                          previewId: preview.id,
                        }),
                      ),
                    )
                  }
                >
                  {t('securityProtection_apply')}
                </button>
              </div>
            ) : null}
          </fieldset>
          <h2>{t('securityProtection_bans')}</h2>
          {state.bans.length ? (
            state.bans.map((ban) => (
              <p key={ban.id}>
                {t(`securityProtection_${ban.plane}`)} · {ban.source} · {ban.expiresAt}{' '}
                <button
                  type="button"
                  className="designer-btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      saveState(await command({ action: 'network.unban', id: ban.id })),
                    )
                  }
                >
                  {t('securityProtection_unban')}
                </button>
              </p>
            ))
          ) : (
            <p>{t('securityCenterEmpty')}</p>
          )}
          <p className="security-center-note">{t('securityProtection_localRepair')}</p>
        </>
      ) : null}
      {section === 'keys' && maintenance ? (
        <>
          <dl>
            <dt>{t('securityCenterInstance')}</dt>
            <dd>
              <code>{maintenance.keys.instanceId}</code>
            </dd>
            <dt>{t('securityMaintenance_master')}</dt>
            <dd>
              <code>{maintenance.keys.masterKeyId}</code>
            </dd>
            <dt>{t('securityMaintenance_history')}</dt>
            <dd>{maintenance.keys.retainedMasterKeys}</dd>
            <dt>{t('securityMaintenance_rotation')}</dt>
            <dd>
              {maintenance.keys.rotation
                ? t(`securityMaintenance_${maintenance.keys.rotation.phase}`)
                : '-'}
            </dd>
          </dl>
          <label className="security-protection-checkbox">
            <input
              type="checkbox"
              checked={rotateConfirmed}
              onChange={(event) => setRotateConfirmed(event.target.checked)}
            />
            {t('securityMaintenance_confirm')}
          </label>
          <button
            type="button"
            className="designer-btn"
            disabled={busy || !rotateConfirmed}
            onClick={() =>
              void run(async () => {
                await command({ action: 'master.rotate', confirm: true });
                setRotateConfirmed(false);
                await refresh();
              })
            }
          >
            {t('securityMaintenance_rotate')}
          </button>
          <h2>{t('securityMaintenance_reset')}</h2>
          <p>{t('securityMaintenance_resetNote')}</p>
          <dl>
            <dt>{t('securityCenterInstance')}</dt>
            <dd>
              <code>{maintenance.reset.instanceId}</code>
            </dd>
            <dt>{t('securityMaintenance_target')}</dt>
            <dd>
              <code>{maintenance.reset.target}</code>
            </dd>
          </dl>
          <p className="security-center-note">{t('securityMaintenance_resetCommand')}</p>
        </>
      ) : null}
    </section>
  );
}
