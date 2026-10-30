import type { DeviceRegistrationConnectionDescriptorV1 } from './device-registration-contracts.js';
import type { SecuritySourcePolicy } from './security-contracts.js';

/** Only public certificate data and explicit deployment choices; never private key contents. */
export interface DeploymentDraft {
  mode: 'local' | 'lan';
  port: number;
  serverOrigin?: string;
  rpId?: string;
  certificatePem?: string;
  certificateFile?: string;
  privateKeyFile?: string;
  tlsMode?: 'public-ca' | 'owner-pinned';
  spkiSha256?: string;
  allowedSources?: string[];
  registrationEnabled?: boolean;
  windowHours?: number;
}
export interface DeploymentWizardStatus {
  instanceId: string;
  eligible: boolean;
  bootstrapSha256?: string;
}
export interface DeploymentPlan {
  format: 'modeldb.deployment-plan.v1';
  instanceId: string;
  bootstrapSha256: string;
  preparedAtUtc: string;
  draft: DeploymentDraft;
}
export interface DeploymentCandidateConfig {
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  workspace: 'vault';
  logDir: 'logs';
  designerWorkspace: 'model_designer_workspace';
  security: {
    version: 1;
    hosting: { enabled: true; designerDirectory: string; managementPort: 0 };
    network: {
      transport:
        | { mode: 'loopback' }
        | { mode: 'tls'; certificateFile: string; privateKeyFile: string };
      allowedOrigins?: string[];
      data: SecuritySourcePolicy;
      management: SecuritySourcePolicy;
    };
    authentication?: { enabled: true; allowStorageMigration: true };
    registration?: {
      descriptor: DeviceRegistrationConnectionDescriptorV1;
      allowStorageMigration: true;
    };
  };
  publicBaseUrl?: string;
}
export interface DeploymentPreview {
  plan: DeploymentPlan;
  digest: string;
  expiresAtUtc: string;
  config: DeploymentCandidateConfig;
  descriptor?: DeviceRegistrationConnectionDescriptorV1;
  certificate?: {
    spkiSha256: string;
    validFromUtc: string;
    validToUtc: string;
    hostnameMatches: true;
  };
  /** Metadata checks never establish OS/browser certificate trust or DNS reachability. */
  trustVerified: false;
  dnsVerified: false;
  keyMatchVerified: false;
}
export type DeploymentWizardCommand =
  | { action: 'deployment.status' }
  | { action: 'deployment.preview'; draft: DeploymentDraft };
export type DeploymentWizardResult<T extends DeploymentWizardCommand> = {
  'deployment.status': DeploymentWizardStatus;
  'deployment.preview': DeploymentPreview;
}[T['action']];
