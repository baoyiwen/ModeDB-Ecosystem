import { withBusinessLibrarySession } from '../engine/business-library-session.js';
import {
  invokeInterfacePivot,
  queryModelPivot,
  type PivotModelFieldPolicy,
} from './sources/index.js';
import type { PivotDocument, PivotSource } from './types.js';

export async function executeModelPivot(options: {
  readonly libraryName: string;
  readonly source: Extract<PivotSource, { readonly kind: 'model' }>;
  readonly fieldPolicy?: PivotModelFieldPolicy;
}): Promise<PivotDocument> {
  return withBusinessLibrarySession(options.libraryName, (client) =>
    queryModelPivot({ client, source: options.source, fieldPolicy: options.fieldPolicy }),
  );
}

export async function executeInterfacePivot(options: {
  readonly libraryName: string;
  readonly source: Extract<PivotSource, { readonly kind: 'interface' }>;
  readonly parameters?: Readonly<Record<string, unknown>>;
}): Promise<PivotDocument> {
  return withBusinessLibrarySession(options.libraryName, (client) =>
    invokeInterfacePivot({
      client,
      source: options.source,
      parameters: options.parameters,
    }),
  );
}
