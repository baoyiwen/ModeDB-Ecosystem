import { securityReleaseDigest, type SecurityAction, type WireExecuteBody } from '@mode-db/shared';
import type { AuthoringEngine } from '@mode-db/core';
import type { VerifiedCredential } from './security-registry.js';
import { SecurityError } from './security-errors.js';

/** Reverify at every boundary, including after a write-gate wait. */
export class AuthorizationService {
  constructor(
    private readonly verify: () => VerifiedCredential,
    private readonly designerWorkspace: string,
  ) {}

  /** Carry a parent delegation through every child check and batch item. */
  scoped(check: () => void): AuthorizationService {
    return new AuthorizationService(() => {
      check();
      return this.verify();
    }, this.designerWorkspace);
  }

  /** Wildcards cover resources in one explicitly named database only. */
  require(database: string, action: SecurityAction, resource = '*'): void {
    const identity = this.verify();
    if (
      !identity.credential.grants.some(
        (g) =>
          g.database === database &&
          g.actions.includes(action) &&
          (g.resource === resource || g.resource === '*'),
      )
    ) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
  }

  /** Reject before opening any caller-selected Vault or reading its metadata. */
  preflight(database: string, body: WireExecuteBody): void {
    if (body.op === 'executeInterface') {
      return this.require(database, 'callable.query', body.callableName);
    }
    if (body.op === 'executeOperationInterface') {
      return this.require(database, 'callable.operation', body.callableName);
    }
    if (body.op === 'executeBindingSurface') {
      return this.require(database, 'callable.binding', body.surfaceId);
    }
    this.require(database, 'model.read');
    if (!['executeQuery', 'previewBind', 'relationStats'].includes(body.op)) {
      this.require(database, 'model.write');
    }
  }

  /** Delegate only the exact published release selected by its runtime. */
  release(database: string, action: SecurityAction, resource: string, release: unknown): void {
    const candidates = this.verify().credential.grants.filter(
      (g) => g.database === database && g.resource === resource && g.actions.includes(action),
    );
    if (!candidates.length) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    const digest = securityReleaseDigest(release);
    if (!candidates.some((g) => g.releaseDigest === digest)) {
      throw new SecurityError('SECURITY_RELEASE_SCOPE_CHANGED');
    }
  }

  /** Whole-database raw-RPC scope conservatively covers traversal and indirect writes. */
  async operation(
    database: string,
    body: WireExecuteBody,
    engine: AuthoringEngine,
  ): Promise<() => void> {
    const checks: Array<() => void> = [() => this.preflight(database, body)];
    const require = (db: string, action: SecurityAction): void => {
      const check = () => this.require(db, action);
      check();
      checks.push(check);
    };
    const finalCheck = (): void => {
      for (const check of checks) {
        check();
      }
    };
    if (
      database === this.designerWorkspace ||
      engine.registry.getModelDefinitions().some((m) => m.name.startsWith('sys_'))
    ) {
      require(database, 'schema.manage');
    }
    if (
      [
        'registerModel',
        'registerRelation',
        'batchRegister',
        'alterModel',
        'dropModel',
        'dropRelation',
        'updateRelationLogic',
      ].includes(body.op)
    ) {
      require(database, 'schema.manage');
      require(database, 'model.write');
      return finalCheck;
    }
    if (['executeQuery', 'previewBind', 'relationStats'].includes(body.op)) {
      require(database, 'model.read');
      return finalCheck;
    }
    require(database, 'model.read');
    require(database, 'model.write');
    if (['insertMany', 'bindImportLookup'].includes(body.op)) {
      require(database, 'transfer.import');
    }
    await this.authorizePublicationWrites(body, engine, require);
    finalCheck();
    return finalCheck;
  }

  private async authorizePublicationWrites(
    body: WireExecuteBody,
    engine: AuthoringEngine,
    require: (database: string, action: SecurityAction) => void,
  ): Promise<void> {
    const publicationModels = new Set([
      'sys_query_interface',
      'sys_operation_interface',
      'sys_binding_surface',
    ]);
    const checkRow = async (
      model: string,
      data: Record<string, unknown>,
      id?: string,
    ): Promise<void> => {
      if (!publicationModels.has(model)) {
        return;
      }
      const existing = id
        ? (await engine.persistence.getMergedReader().getAll(model)).find((row) => row._id === id)
        : undefined;
      const row = { ...existing, ...data };
      if (existing?.library_code && existing.library_code !== row.library_code) {
        if (typeof existing.library_code !== 'string') {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        require(existing.library_code, 'schema.manage');
      }
      const database = row.library_code;
      if (typeof database !== 'string' || !database) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      // Publishing authorizes a future delegate, so the publisher must hold full authoring
      // authority on its business database as well as on the designer metadata database.
      require(database, 'schema.manage');
      require(database, 'model.read');
      if (model !== 'sys_query_interface') {
        require(database, 'model.write');
      }
    };
    if (body.op === 'insert') {
      await checkRow(body.model, body.data);
    } else if (body.op === 'update') {
      await checkRow(body.model, body.partial, body.id);
    } else if (body.op === 'insertMany') {
      for (const row of body.rows) {
        await checkRow(body.model, row);
      }
    } else if (body.op === 'batchUpdate') {
      for (const update of body.updates) {
        await checkRow(update.model, update.partial, update.id);
      }
    }
  }
}
