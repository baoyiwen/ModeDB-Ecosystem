/** Session authority namespace. IDs from different namespaces are never interchangeable. */
export type SecuritySessionParent =
  | { readonly kind: 'api-credential'; readonly credentialId: string }
  | {
      readonly kind: 'registered-public-key';
      readonly credentialId: string;
      readonly userId: string;
    }
  | { readonly kind: 'local-management'; readonly credentialId: string };

/** Non-secret identity context reserved for the unified authorization layer. */
export interface SecurityActor {
  readonly principalId?: string;
  readonly credentialId?: string;
  readonly applicationId?: string;
  readonly userSubject?: string;
  readonly userSubjectTrust?: 'application-asserted';
  readonly identityTrust: 'verified' | 'application-asserted' | 'unverified';
}

/** V1 audit event contract. Ingestion must allow-list fields, never log request bodies. */
export interface DataSecurityEvent {
  readonly version: 1;
  readonly eventId: string;
  readonly timestampUtc: string;
  readonly category: 'authentication' | 'network' | 'management' | 'data';
  readonly plane?: 'data' | 'management';
  readonly action: string;
  readonly result: 'started' | 'succeeded' | 'denied' | 'failed';
  readonly reasonCode?: string;
  readonly requestId?: string;
  readonly taskId?: string;
  readonly actor: SecurityActor;
  readonly source: {
    readonly transport: 'http' | 'websocket' | 'local-ipc';
    readonly peerIp?: string;
    readonly clientIp?: string;
    readonly clientIpBasis?: 'socket' | 'trusted-proxy';
  };
  readonly resource?: {
    readonly principalId?: string;
    readonly credentialId?: string;
    readonly database?: string;
    readonly model?: string;
    readonly callable?: string;
  };
  readonly policyVersion?: number;
  readonly ruleId?: string;
  readonly durationMs?: number;
  readonly affectedCount?: number;
  /** Offline sealed package metadata. Never contains public/private keys or payload values. */
  readonly delivery?: {
    readonly recipientKeyId: string;
    readonly userId: string;
    readonly keyVersion: number;
    readonly fingerprint: string;
    readonly packageSha256: string;
    readonly kind: 'backup' | 'asset';
  };
  /** One durable anonymous rejection row per source/reason/transport/plane/minute. */
  readonly aggregation?: {
    readonly windowStartUtc: string;
    readonly firstSeenUtc: string;
    readonly lastSeenUtc: string;
    readonly observedCount: number;
    readonly savedDetails: 1;
    readonly suppressedDetails: number;
    readonly sampleRequestIds: readonly string[];
  };
}

/** Restricted, metadata-only query for the security audit ledger. */
export interface SecurityAuditQuery {
  readonly fromUtc?: string;
  readonly toUtc?: string;
  readonly category?: DataSecurityEvent['category'];
  readonly action?: string;
  readonly result?: DataSecurityEvent['result'];
  readonly principalId?: string;
  readonly credentialId?: string;
  readonly database?: string;
  readonly requestId?: string;
  readonly clientIp?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface SecurityAuditSummary {
  readonly total: number;
  readonly observedCount: number;
  readonly savedDetails: number;
  readonly suppressedDetails: number;
  readonly byCategory: Readonly<Record<DataSecurityEvent['category'], number>>;
  readonly byResult: Readonly<Record<DataSecurityEvent['result'], number>>;
  readonly uniqueClientIps: number;
}

export interface SecurityAuditPage {
  readonly version: 1;
  readonly events: readonly DataSecurityEvent[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly summary: SecurityAuditSummary;
}

/** Future portable key envelope; algorithm-specific payloads are validated by the importer. */
export interface RecoveryKeyEnvelopeV1 {
  readonly version: 1;
  readonly purpose: 'database-recovery' | 'package-delivery';
  readonly recipientKeyId: string;
  readonly contentKeyId: string;
  readonly suite: 'HPKE' | 'JWE';
  readonly payload: string;
}

/** Explicit resource grant. Authorization enforcement is provided by SEC-M3. */
export interface SecurityGrant {
  readonly database: string;
  readonly resource: string;
  readonly actions: readonly SecurityAction[];
  /** SHA-256 of the canonical complete published release; required for callable grants. */
  readonly releaseDigest?: string;
}

/** Data capabilities; API credentials cannot grant local recovery authority. */
export type SecurityAction =
  | 'model.read'
  | 'model.write'
  | 'schema.manage'
  | 'database.manage'
  | 'callable.query'
  | 'callable.operation'
  | 'callable.binding'
  | 'transfer.import'
  | 'transfer.export'
  | 'backup.manage';

/** Safe credential metadata returned by management; no hash or original token. */
export interface SecurityCredentialInfo {
  readonly id: string;
  readonly principalId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly validUntil?: string;
  readonly replacesId?: string;
  readonly grants: readonly SecurityGrant[];
}

export interface SecurityRegistryStatus {
  readonly instanceId: string;
  readonly revision: number;
  readonly policyVersion: number;
  readonly accessEpoch: number;
  readonly principals: number;
  readonly credentials: number;
  readonly sessions: number;
  readonly auditEvents: number;
  readonly auditHealth: {
    readonly maxEvents: number;
    readonly usagePercent: number;
    readonly status: 'healthy' | 'warning' | 'critical';
    readonly retentionDays: number;
    readonly oldestEventUtc?: string;
  };
}

export interface SecurityCenterPrincipal {
  readonly id: string;
  readonly name: string;
  readonly kind: 'application' | 'operator';
  readonly enabled: boolean;
}

export interface SecurityCenterSession {
  readonly id: string;
  readonly principalId: string;
  readonly credentialId: string;
  /** Absent on older servers. Contains metadata only, never authentication material. */
  readonly parent?: SecuritySessionParent;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly origin?: string;
  readonly active: boolean;
  readonly securityAdmin: boolean;
}

export interface SecurityKeyReference {
  readonly instanceId: string;
  readonly databaseId: string;
  readonly keyId: string;
  readonly keyVersion: number;
}

export interface SecurityCenterSnapshot {
  readonly status: SecurityRegistryStatus;
  readonly principals: readonly SecurityCenterPrincipal[];
  readonly credentials: readonly SecurityCredentialInfo[];
  readonly sessions: readonly SecurityCenterSession[];
  readonly keyReferences: readonly SecurityKeyReference[];
}

export interface SecurityNetworkStatus {
  readonly mode: 'loopback' | 'tls' | 'proxy';
  readonly allowedOriginCount: number;
  readonly trustedProxyCount: number;
  readonly data: {
    readonly allowListEnabled: boolean;
    readonly allowRules: number;
    readonly denyRules: number;
  };
  readonly management: {
    readonly allowListEnabled: boolean;
    readonly allowRules: number;
    readonly denyRules: number;
  };
}

export interface SecurityCenterOverview {
  readonly version: 1;
  readonly registry: SecurityCenterSnapshot;
  readonly network: SecurityNetworkStatus | null;
  readonly requestId: string;
}

export type SecurityPlane = 'data' | 'management';

export interface SecuritySourceRule {
  readonly id: string;
  readonly source: string;
  readonly expiresAt?: string;
  readonly reason?: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
}

export interface SecuritySourcePolicy {
  readonly allowListEnabled?: boolean;
  readonly allow?: readonly SecuritySourceRule[];
  readonly deny?: readonly SecuritySourceRule[];
}

export interface SecurityProtectionConfig {
  readonly data: SecuritySourcePolicy;
  readonly management: SecuritySourcePolicy;
  readonly rate: {
    readonly windowSeconds: number;
    readonly dataRequests: number;
    readonly managementRequests: number;
    readonly principalRequests: number;
    readonly authenticationFailures: number;
    readonly autoBan: boolean;
    readonly banSeconds: number;
    readonly exemptManagementSources: readonly string[];
  };
}

export interface SecurityTemporaryBan {
  readonly id: string;
  readonly source: string;
  readonly plane: SecurityPlane;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly reason: 'authentication-failures';
}

export interface SecurityProtectionState {
  readonly version: 1;
  readonly revision: number;
  readonly clockUtc: string;
  readonly config: SecurityProtectionConfig;
  readonly bans: readonly SecurityTemporaryBan[];
  readonly pending?: {
    readonly id: string;
    readonly expiresAt: string;
    readonly previous: SecurityProtectionConfig;
  };
  readonly previous?: SecurityProtectionConfig;
}

export interface SecurityProtectionPreview {
  readonly id: string;
  readonly expiresAt: string;
  readonly revision: number;
  readonly connections: readonly {
    readonly clientIp: string;
    readonly plane: SecurityPlane;
    readonly allowed: boolean;
  }[];
}

export interface SecurityMaintenanceStatus {
  readonly keys: {
    readonly instanceId: string;
    readonly masterKeyId: string;
    readonly retainedMasterKeys: number;
    readonly rotation?: {
      readonly id: string;
      readonly phase: 'rewrapping' | 'completed';
      readonly startedAt: string;
      readonly completedAt?: string;
    };
  };
  readonly reset: {
    readonly instanceId: string;
    readonly target: string;
    readonly offlineRequired: true;
  };
}

export type SecurityControlRequest =
  | { readonly action: 'network.status' }
  | { readonly action: 'network.preview'; readonly config: SecurityProtectionConfig }
  | {
      readonly action: 'network.apply';
      readonly config: SecurityProtectionConfig;
      readonly revision: number;
      readonly previewId: string;
    }
  | { readonly action: 'network.confirm'; readonly id: string }
  | { readonly action: 'network.rollback'; readonly revision: number }
  | { readonly action: 'network.unban'; readonly id: string }
  | { readonly action: 'maintenance.status' }
  | { readonly action: 'master.rotate'; readonly confirm: true };

export type SecurityControlResult<T extends SecurityControlRequest> =
  T['action'] extends 'network.preview'
    ? SecurityProtectionPreview
    : T['action'] extends 'maintenance.status'
      ? SecurityMaintenanceStatus
      : T['action'] extends 'master.rotate'
        ? SecurityMaintenanceStatus['keys']
        : SecurityProtectionState;
