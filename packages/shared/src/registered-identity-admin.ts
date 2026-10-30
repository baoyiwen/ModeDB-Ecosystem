/** Metadata-only commands for the OS-paired, dedicated loopback management listener. */
import type { SecurityGrant, SecurityCenterSession } from './security-contracts.js';

type PageRequest = { instanceId: string; offset?: number; limit?: number };
type Mutation = { instanceId: string; id: string; revision: number; confirm: true };
export type RegisteredIdentityCommand =
  | (PageRequest & { action: 'registration.list' })
  | (PageRequest & { action: 'registration.users.list' })
  | (PageRequest & { action: 'registration.credentials.list'; userId?: string })
  | (PageRequest & { action: 'registration.sessions.list' })
  | (Mutation & {
      action: 'registration.approve';
      principalId?: string;
      name?: string;
      grants: SecurityGrant[];
    })
  | (Mutation & {
      action:
        | 'registration.reject'
        | 'registration.user.disable'
        | 'registration.user.enable'
        | 'registration.credential.disable'
        | 'registration.credential.enable'
        | 'registration.credential.revoke'
        | 'registration.session.revoke';
    })
  | (Mutation & { action: 'registration.credential.restrict'; grants: SecurityGrant[] })
  | (Mutation & {
      action: 'registration.credential.replace';
      applicationId: string;
      grants: SecurityGrant[];
    });

export interface RegisteredApplicationInfo {
  id: string;
  displayName: string;
  createdAtUtc: string;
  expiresAtUtc: string;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  proofVerified: boolean;
  serverOrigin: string;
  rpId: string;
  publicKeyFingerprint?: string;
  algorithm?: number;
  deviceType?: string;
  backedUp?: boolean;
  principalId?: string;
  userId?: string;
  credentialId?: string;
  grants?: SecurityGrant[];
}
export interface RegisteredUserInfo {
  id: string;
  principalId: string;
  displayName: string;
  enabled: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
  credentialCount: number;
}
export interface RegisteredCredentialInfo {
  id: string;
  applicationId: string;
  userId: string;
  principalId: string;
  state: 'active' | 'disabled' | 'revoked';
  userEnabled: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
  publicKeyFingerprint: string;
  algorithm: number;
  deviceType: string;
  backedUp: boolean;
  grants: SecurityGrant[];
}
interface Page {
  instanceId: string;
  revision: number;
  total: number;
  offset: number;
  nextOffset: number | null;
}
export type RegisteredApplicationPage = Page & { applications: RegisteredApplicationInfo[] };
export type RegisteredUserPage = Page & { users: RegisteredUserInfo[] };
export type RegisteredCredentialPage = Page & { credentials: RegisteredCredentialInfo[] };
export type RegisteredSessionPage = Page & { sessions: SecurityCenterSession[] };
export type RegisteredIdentityResult<T extends RegisteredIdentityCommand> = {
  [Action in RegisteredIdentityCommand['action']]: Action extends 'registration.list'
    ? RegisteredApplicationPage
    : Action extends 'registration.users.list'
      ? RegisteredUserPage
      : Action extends 'registration.credentials.list'
        ? RegisteredCredentialPage
        : Action extends 'registration.sessions.list'
          ? RegisteredSessionPage
          : {
              instanceId: string;
              revision: number;
              state?: string;
              enabled?: boolean;
              credentialId?: string;
              userId?: string;
              registrationId?: string;
              replacementCredentialId?: string;
              grants?: SecurityGrant[];
              sessionId?: string;
            };
}[T['action']];
