import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  ConnectionSecurityError,
  exportSecurityAudit,
  getSecurityAudit,
  getBrowserSession,
  getSecurityCenterOverview,
  type SecurityCenterOverview,
  type SecurityAuditPage,
  type SecurityAuditQuery,
} from '@mode-db/sdk';
import { connectionSecurityIssue } from '@mode-db/sdk';
import { useDesigner } from '../context/designer-context.js';
import { getStoredHost, getStoredPort } from '../config/connection-prefs.js';
import { SecurityProtectionPanel } from './SecurityProtectionPanel.js';

type Section =
  | 'overview'
  | 'principals'
  | 'credentials'
  | 'sessions'
  | 'permissions'
  | 'network'
  | 'keys'
  | 'audit';

type AuditFilters = Omit<SecurityAuditQuery, 'offset' | 'limit'>;
type AuditCategory = NonNullable<SecurityAuditQuery['category']>;
type AuditResult = NonNullable<SecurityAuditQuery['result']>;

const auditCategories: AuditCategory[] = ['authentication', 'network', 'management', 'data'];
const auditResults: AuditResult[] = ['started', 'succeeded', 'denied', 'failed'];

type AuditFilterDraft = {
  fromLocal: string;
  toLocal: string;
  category: AuditCategory | '';
  action: string;
  result: AuditResult | '';
  principalId: string;
  credentialId: string;
  database: string;
  requestId: string;
  clientIp: string;
};

const EMPTY_AUDIT_DRAFT: AuditFilterDraft = {
  fromLocal: '',
  toLocal: '',
  category: '',
  action: '',
  result: '',
  principalId: '',
  credentialId: '',
  database: '',
  requestId: '',
  clientIp: '',
};

const sections: readonly Section[] = [
  'overview',
  'principals',
  'credentials',
  'sessions',
  'permissions',
  'network',
  'keys',
  'audit',
];

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

export function SecurityCenterWorkspace({
  onDisconnect,
}: { onDisconnect?: () => void } = {}): ReactElement {
  const { i18n } = useDesigner();
  const [section, setSection] = useState<Section>('overview');
  const [overview, setOverview] = useState<SecurityCenterOverview>();
  const [audit, setAudit] = useState<SecurityAuditPage>();
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>({});
  const [auditDraft, setAuditDraft] = useState<AuditFilterDraft>(EMPTY_AUDIT_DRAFT);
  const [auditExporting, setAuditExporting] = useState(false);
  const [auditExportError, setAuditExportError] = useState(false);
  const [auditFilterError, setAuditFilterError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string>();
  const [adminSession, setAdminSession] = useState<boolean>();

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErrorCode(undefined);
    try {
      const endpoint = { host: getStoredHost('127.0.0.1'), port: getStoredPort(9090) };
      const session = await getBrowserSession(endpoint);
      setAdminSession(session.securityAdmin === true);
      if (session.securityAdmin !== true) {
        setOverview(undefined);
        setErrorCode('SECURITY_FORBIDDEN');
        return;
      }
      setOverview(await getSecurityCenterOverview(endpoint));
      setAudit(
        await getSecurityAudit(endpoint, { ...auditFilters, offset: auditOffset, limit: 50 }),
      );
    } catch (error) {
      setOverview(undefined);
      setErrorCode(
        error instanceof ConnectionSecurityError ? error.code : 'SECURITY_CONNECTION_UNAVAILABLE',
      );
      if (connectionSecurityIssue(error) === 'credentials') setAdminSession(false);
    } finally {
      setLoading(false);
    }
  }, [auditFilters, auditOffset]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const t = (key: string): string => i18n.t('ui', key);
  const registry = overview?.registry;
  const principalNames = new Map(
    registry?.principals.map((principal) => [principal.id, principal.name] as const) ?? [],
  );
  const credentialNames = new Map(
    registry?.credentials.map((credential) => [credential.id, credential.name] as const) ?? [],
  );

  const applyAuditFilters = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      auditDraft.fromLocal &&
      auditDraft.toLocal &&
      Date.parse(auditDraft.fromLocal) > Date.parse(auditDraft.toLocal)
    ) {
      setAuditFilterError(true);
      return;
    }
    const next: AuditFilters = {
      ...(auditDraft.fromLocal ? { fromUtc: new Date(auditDraft.fromLocal).toISOString() } : {}),
      ...(auditDraft.toLocal ? { toUtc: new Date(auditDraft.toLocal).toISOString() } : {}),
      ...(auditDraft.category ? { category: auditDraft.category } : {}),
      ...(auditDraft.action.trim() ? { action: auditDraft.action.trim() } : {}),
      ...(auditDraft.result ? { result: auditDraft.result } : {}),
      ...(auditDraft.principalId.trim() ? { principalId: auditDraft.principalId.trim() } : {}),
      ...(auditDraft.credentialId.trim() ? { credentialId: auditDraft.credentialId.trim() } : {}),
      ...(auditDraft.database.trim() ? { database: auditDraft.database.trim() } : {}),
      ...(auditDraft.requestId.trim() ? { requestId: auditDraft.requestId.trim() } : {}),
      ...(auditDraft.clientIp.trim() ? { clientIp: auditDraft.clientIp.trim() } : {}),
    };
    setAuditFilterError(false);
    setAuditExportError(false);
    setAuditFilters(next);
    setAuditOffset(0);
  };

  const resetAuditFilters = (): void => {
    setAuditDraft(EMPTY_AUDIT_DRAFT);
    setAuditFilters({});
    setAuditFilterError(false);
    setAuditExportError(false);
    setAuditOffset(0);
  };

  const downloadAudit = async (): Promise<void> => {
    setAuditExporting(true);
    setAuditExportError(false);
    try {
      const endpoint = { host: getStoredHost('127.0.0.1'), port: getStoredPort(9090) };
      const blob = await exportSecurityAudit(endpoint, auditFilters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `modeldb-security-audit-${new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z')}.jsonl`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setAuditExportError(true);
    } finally {
      setAuditExporting(false);
    }
  };

  const table = (headers: readonly string[], rows: readonly (readonly ReactElement[])[]) => (
    <div className="security-center-table-wrap">
      <table className="security-center-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((cells, index) => <tr key={index}>{cells}</tr>)
          ) : (
            <tr>
              <td colSpan={headers.length} className="security-center-empty">
                {t('securityCenterEmpty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const content = (): ReactElement => {
    if (loading)
      return (
        <div className="security-center-state" aria-busy="true">
          {t('securityCenterLoading')}
        </div>
      );
    if (errorCode || !overview || !registry) {
      const forbidden = errorCode === 'SECURITY_FORBIDDEN' || adminSession === false;
      return (
        <section className="security-center-access-state" role="status">
          <h2>{forbidden ? t('securityCenterAccessRequired') : t('securityCenterUnavailable')}</h2>
          <p>{forbidden ? t('securityCenterAccessHint') : t('securityCenterLoadFailed')}</p>
          {forbidden ? (
            <div className="security-center-launch-command">
              <p>{t('securityCenterOpenCommand')}</p>
              <code>modeldb-server security security-open</code>
            </div>
          ) : null}
          <button type="button" className="designer-btn" onClick={() => void refresh()}>
            {t('securityCenterRefresh')}
          </button>
        </section>
      );
    }

    if (section === 'overview') {
      const metrics = [
        [t('securityCenterPrincipals'), registry.status.principals],
        [t('securityCenterCredentials'), registry.status.credentials],
        [t('securityCenterActiveSessions'), registry.sessions.filter((item) => item.active).length],
        [t('securityCenterKeyReferences'), registry.keyReferences.length],
        [t('securityCenterAuditEvents'), registry.status.auditEvents],
      ] as const;
      return (
        <>
          <div className="security-center-metrics">
            {metrics.map(([label, value]) => (
              <div className="security-center-metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <dl className="security-center-facts">
            <div>
              <dt>{t('securityCenterInstance')}</dt>
              <dd>
                <code>{registry.status.instanceId}</code>
              </dd>
            </div>
            <div>
              <dt>{t('securityCenterRevision')}</dt>
              <dd>{registry.status.revision}</dd>
            </div>
            <div>
              <dt>{t('securityCenterPolicyVersion')}</dt>
              <dd>{registry.status.policyVersion}</dd>
            </div>
            <div>
              <dt>{t('securityCenterAccessEpoch')}</dt>
              <dd>{registry.status.accessEpoch}</dd>
            </div>
          </dl>
          <div className="security-center-note">{t('securityCenterOverviewNote')}</div>
        </>
      );
    }

    if (section === 'credentials') {
      return table(
        [
          t('securityCenterCredential'),
          t('securityCenterPrincipal'),
          t('securityCenterCreated'),
          t('securityCenterExpires'),
          t('securityCenterGrantCount'),
          t('securityCenterStatus'),
        ],
        registry.credentials.map((credential) => [
          <td key="name">
            <strong>{credential.name}</strong>
            <small>{credential.id}</small>
          </td>,
          <td key="principal">
            {principalNames.get(credential.principalId) ?? credential.principalId}
          </td>,
          <td key="created">{formatDate(credential.createdAt)}</td>,
          <td key="expires">{formatDate(credential.validUntil ?? credential.expiresAt)}</td>,
          <td key="grants">{credential.grants.length}</td>,
          <td key="status">
            {credential.revokedAt ? t('securityCenterRevoked') : t('securityCenterMetadataOnly')}
          </td>,
        ]),
      );
    }

    if (section === 'principals') {
      return table(
        [
          t('securityCenterPrincipal'),
          t('securityCenterPrincipalId'),
          t('securityCenterPrincipalType'),
          t('securityCenterStatus'),
        ],
        registry.principals.map((principal) => [
          <td key="name">
            <strong>{principal.name}</strong>
          </td>,
          <td key="id">
            <code>{principal.id}</code>
          </td>,
          <td key="type">{t(`securityCenterPrincipalType_${principal.kind}`)}</td>,
          <td key="status">
            {principal.enabled ? t('securityCenterEnabled') : t('securityCenterDisabled')}
          </td>,
        ]),
      );
    }

    if (section === 'sessions') {
      return table(
        [
          t('securityCenterPrincipal'),
          t('securityCenterCredential'),
          t('securityCenterOrigin'),
          t('securityCenterCreated'),
          t('securityCenterExpires'),
          t('securityCenterStatus'),
        ],
        registry.sessions.map((session) => [
          <td key="principal">{principalNames.get(session.principalId) ?? session.principalId}</td>,
          <td key="credential">
            {credentialNames.get(session.credentialId) ?? session.credentialId}
            {session.securityAdmin ? <small>{t('securityCenterAdminSession')}</small> : null}
          </td>,
          <td key="origin">{session.origin ?? '-'}</td>,
          <td key="created">{formatDate(session.createdAt)}</td>,
          <td key="expires">{formatDate(session.expiresAt)}</td>,
          <td key="status">
            {session.active
              ? t('securityCenterActive')
              : session.revokedAt
                ? t('securityCenterRevoked')
                : t('securityCenterExpired')}
          </td>,
        ]),
      );
    }

    if (section === 'permissions') {
      const groupedRows = registry.credentials.flatMap((credential) =>
        credential.grants.map((grant, index) => [
          <td key={`credential-${index}`}>
            <strong>{credential.name}</strong>
          </td>,
          <td key={`database-${index}`}>{grant.database}</td>,
          <td key={`resource-${index}`}>{grant.resource}</td>,
          <td key={`actions-${index}`}>{grant.actions.join(', ')}</td>,
        ]),
      );
      return (
        <>
          {table(
            [
              t('securityCenterCredential'),
              t('securityCenterDatabase'),
              t('securityCenterResource'),
              t('securityCenterActions'),
            ],
            groupedRows,
          )}
          <p className="security-center-note">{t('securityCenterPermissionNote')}</p>
        </>
      );
    }

    if (section === 'network') {
      const network = overview.network;
      const facts: readonly (readonly [string, string | number])[] = network
        ? [
            [t('securityCenterTransportMode'), t(`securityCenterMode_${network.mode}`)],
            [t('securityCenterAllowedOrigins'), network.allowedOriginCount],
            [t('securityCenterTrustedProxies'), network.trustedProxyCount],
            [
              t('securityCenterDataAllowList'),
              network.data.allowListEnabled
                ? t('securityCenterEnabled')
                : t('securityCenterDisabled'),
            ],
            [
              t('securityCenterDataRules'),
              `${network.data.allowRules} / ${network.data.denyRules}`,
            ],
            [
              t('securityCenterManagementAllowList'),
              network.management.allowListEnabled
                ? t('securityCenterEnabled')
                : t('securityCenterDisabled'),
            ],
            [
              t('securityCenterManagementRules'),
              `${network.management.allowRules} / ${network.management.denyRules}`,
            ],
          ]
        : [];
      return (
        <>
          {table(
            [t('securityCenterSetting'), t('securityCenterValue')],
            facts.map(([label, value]) => [
              <td key="setting">{label}</td>,
              <td key="value">{value}</td>,
            ]),
          )}
          <p className="security-center-note">{t('securityCenterNetworkNote')}</p>
          <SecurityProtectionPanel key="network" section="network" />
        </>
      );
    }

    if (section === 'audit') {
      const page = audit;
      if (!page) return <div className="security-center-state">{t('securityCenterLoading')}</div>;
      const health = registry.status.auditHealth;
      const eventRows = page.events.map((event) => [
        <td key="time">{formatDate(event.timestampUtc)}</td>,
        <td key="result">{event.result}</td>,
        <td key="category">{event.category}</td>,
        <td key="action">
          <code>{event.action}</code>
          {event.aggregation ? (
            <small>
              {t('securityCenterAuditObserved')}: {event.aggregation.observedCount}
            </small>
          ) : null}
        </td>,
        <td key="actor">
          {event.actor.principalId ?? '-'}
          {event.actor.userSubject ? <small>{event.actor.userSubject}</small> : null}
        </td>,
        <td key="source">
          {event.source.clientIp ?? '-'}
          {event.source.clientIpBasis ? <small>{event.source.clientIpBasis}</small> : null}
        </td>,
        <td key="resource">{event.resource?.database ?? '-'}</td>,
        <td key="request">
          <code>{event.requestId ?? '-'}</code>
        </td>,
      ]);
      return (
        <>
          <section className={`security-center-audit-health is-${health.status}`}>
            <div className="security-center-audit-health-heading">
              <strong>{t(`securityCenterAuditHealth_${health.status}`)}</strong>
              <span>
                {t('securityCenterAuditCapacity')
                  .replace('{count}', String(registry.status.auditEvents))
                  .replace('{max}', String(health.maxEvents))}
              </span>
              <span>
                {t('securityCenterAuditRetention').replace('{days}', String(health.retentionDays))}
              </span>
            </div>
            <progress
              max={100}
              value={health.usagePercent}
              aria-label={t('securityCenterAuditUsage')}
            />
            <small>
              {health.usagePercent}%
              {health.oldestEventUtc
                ? ` · ${t('securityCenterAuditOldest')}: ${formatDate(health.oldestEventUtc)}`
                : ''}
            </small>
          </section>
          <form className="security-center-audit-controls" onSubmit={applyAuditFilters}>
            <div className="security-center-audit-filter-grid">
              <label>
                <span>{t('securityCenterAuditFrom')}</span>
                <input
                  type="datetime-local"
                  value={auditDraft.fromLocal}
                  onChange={(event) =>
                    setAuditDraft((current) => ({ ...current, fromLocal: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t('securityCenterAuditTo')}</span>
                <input
                  type="datetime-local"
                  value={auditDraft.toLocal}
                  onChange={(event) =>
                    setAuditDraft((current) => ({ ...current, toLocal: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t('securityCenterAuditCategory')}</span>
                <select
                  value={auditDraft.category}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === '' || auditCategories.includes(value as AuditCategory)) {
                      setAuditDraft((current) => ({
                        ...current,
                        category: value as AuditCategory | '',
                      }));
                    }
                  }}
                >
                  <option value="">{t('securityCenterAuditAll')}</option>
                  {auditCategories.map((value) => (
                    <option key={value} value={value}>
                      {t(`securityCenterAuditCategory_${value}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('securityCenterAuditResult')}</span>
                <select
                  value={auditDraft.result}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === '' || auditResults.includes(value as AuditResult)) {
                      setAuditDraft((current) => ({
                        ...current,
                        result: value as AuditResult | '',
                      }));
                    }
                  }}
                >
                  <option value="">{t('securityCenterAuditAll')}</option>
                  {auditResults.map((value) => (
                    <option key={value} value={value}>
                      {t(`securityCenterAuditResult_${value}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('securityCenterAuditAction')}</span>
                <input
                  value={auditDraft.action}
                  maxLength={64}
                  pattern="[a-z.]+"
                  onChange={(event) =>
                    setAuditDraft((current) => ({ ...current, action: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t('securityCenterAuditClientIp')}</span>
                <input
                  value={auditDraft.clientIp}
                  onChange={(event) =>
                    setAuditDraft((current) => ({ ...current, clientIp: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>{t('securityCenterDatabase')}</span>
                <input
                  value={auditDraft.database}
                  onChange={(event) =>
                    setAuditDraft((current) => ({ ...current, database: event.target.value }))
                  }
                />
              </label>
            </div>
            <details className="security-center-audit-advanced">
              <summary>{t('securityCenterAuditAdvanced')}</summary>
              <div className="security-center-audit-filter-grid">
                <label>
                  <span>{t('securityCenterAuditPrincipalId')}</span>
                  <input
                    value={auditDraft.principalId}
                    onChange={(event) =>
                      setAuditDraft((current) => ({ ...current, principalId: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t('securityCenterAuditCredentialId')}</span>
                  <input
                    value={auditDraft.credentialId}
                    onChange={(event) =>
                      setAuditDraft((current) => ({ ...current, credentialId: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t('securityCenterAuditRequestId')}</span>
                  <input
                    value={auditDraft.requestId}
                    onChange={(event) =>
                      setAuditDraft((current) => ({ ...current, requestId: event.target.value }))
                    }
                  />
                </label>
              </div>
            </details>
            <div className="security-center-audit-actions">
              <button type="submit" className="designer-btn">
                {t('securityCenterAuditApply')}
              </button>
              <button type="button" className="designer-btn" onClick={resetAuditFilters}>
                {t('securityCenterAuditReset')}
              </button>
              <button
                type="button"
                className="designer-btn"
                onClick={() => void downloadAudit()}
                disabled={auditExporting}
              >
                {auditExporting
                  ? t('securityCenterAuditExporting')
                  : t('securityCenterAuditExport')}
              </button>
            </div>
            {auditFilterError ? (
              <p className="security-center-audit-error" role="alert">
                {t('securityCenterAuditInvalidRange')}
              </p>
            ) : null}
            <p className="security-center-note">{t('securityCenterAuditExportNote')}</p>
            {auditExportError ? (
              <p className="security-center-audit-error" role="alert">
                {t('securityCenterAuditExportFailed')}
              </p>
            ) : null}
          </form>
          <div className="security-center-metrics">
            <div className="security-center-metric">
              <span>{t('securityCenterAuditObserved')}</span>
              <strong>{page.summary.observedCount}</strong>
            </div>
            <div className="security-center-metric">
              <span>{t('securityCenterAuditSuppressed')}</span>
              <strong>{page.summary.suppressedDetails}</strong>
            </div>
            <div className="security-center-metric">
              <span>{t('securityCenterAuditTotal')}</span>
              <strong>{page.summary.total}</strong>
            </div>
            <div className="security-center-metric">
              <span>{t('securityCenterAuditSucceeded')}</span>
              <strong>{page.summary.byResult.succeeded}</strong>
            </div>
            <div className="security-center-metric">
              <span>{t('securityCenterAuditDenied')}</span>
              <strong>{page.summary.byResult.denied}</strong>
            </div>
            <div className="security-center-metric">
              <span>{t('securityCenterAuditClientIps')}</span>
              <strong>{page.summary.uniqueClientIps}</strong>
            </div>
          </div>
          {table(
            [
              t('securityCenterAuditTime'),
              t('securityCenterAuditResult'),
              t('securityCenterAuditCategory'),
              t('securityCenterAuditAction'),
              t('securityCenterAuditActor'),
              t('securityCenterAuditClientIp'),
              t('securityCenterDatabase'),
              t('securityCenterAuditRequestId'),
            ],
            eventRows,
          )}
          <div className="security-center-audit-pagination">
            <span>
              {t('securityCenterAuditRange')
                .replace('{start}', String(page.total ? page.offset + 1 : 0))
                .replace('{end}', String(Math.min(page.offset + page.events.length, page.total)))
                .replace('{total}', String(page.total))}
            </span>
            <button
              type="button"
              className="designer-btn"
              disabled={page.offset === 0 || loading}
              onClick={() => setAuditOffset(Math.max(0, page.offset - page.limit))}
            >
              {t('securityCenterAuditPrevious')}
            </button>
            <button
              type="button"
              className="designer-btn"
              disabled={!page.hasMore || loading}
              onClick={() => setAuditOffset(page.offset + page.limit)}
            >
              {t('securityCenterAuditNext')}
            </button>
          </div>
        </>
      );
    }

    return (
      <>
        {table(
          [
            t('securityCenterDatabase'),
            t('securityCenterInstance'),
            t('securityCenterKeyId'),
            t('securityCenterKeyVersion'),
          ],
          registry.keyReferences.map((reference) => [
            <td key="database">{reference.databaseId}</td>,
            <td key="instance">
              <code>{reference.instanceId}</code>
            </td>,
            <td key="key">
              <code>{reference.keyId}</code>
            </td>,
            <td key="version">{reference.keyVersion}</td>,
          ]),
        )}
        <p className="security-center-note">{t('securityCenterRecoveryNote')}</p>
        <SecurityProtectionPanel key="keys" section="keys" />
      </>
    );
  };

  const sectionTitle = (value: Section): string => t(`securityCenterTab_${value}`);

  return (
    <div className="security-center-workspace">
      <aside className="security-center-navigation">
        <div className="security-center-navigation-title">
          <strong>{t('securityCenterTitle')}</strong>
          <span>
            {getStoredHost('127.0.0.1')}:{getStoredPort(9090)}
          </span>
        </div>
        <nav aria-label={t('securityCenterTitle')}>
          {sections.map((value) => (
            <button
              key={value}
              type="button"
              aria-current={section === value ? 'page' : undefined}
              onClick={() => setSection(value)}
            >
              {sectionTitle(value)}
            </button>
          ))}
        </nav>
        {onDisconnect ? (
          <button type="button" className="designer-btn" onClick={onDisconnect}>
            {t('disconnect')}
          </button>
        ) : null}
      </aside>
      <main className="security-center-main">
        <header className="security-center-header">
          <div>
            <h1>{sectionTitle(section)}</h1>
            <p>{t('securityCenterSubtitle')}</p>
          </div>
          <button
            type="button"
            className="designer-btn"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {t('securityCenterRefresh')}
          </button>
        </header>
        <div className="security-center-content">{content()}</div>
      </main>
    </div>
  );
}
