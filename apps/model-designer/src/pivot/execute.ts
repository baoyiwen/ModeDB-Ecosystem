import { withBusinessLibrarySession } from '../engine/business-library-session.js';
import {
  invokeInterfacePivot,
  queryModelPivot,
  type PivotModelFieldPolicy,
  type PivotModelQueryOptions,
} from './sources/index.js';
import type { PivotDocument, PivotSource } from './types.js';

export async function executeModelPivot(options: {
  readonly libraryName: string;
  readonly source: Extract<PivotSource, { readonly kind: 'model' }>;
  readonly fieldPolicy?: PivotModelFieldPolicy;
  readonly filter?: PivotModelQueryOptions['filter'];
  readonly page?: number;
  readonly limit?: number;
}): Promise<PivotDocument> {
  return withBusinessLibrarySession(options.libraryName, (client) =>
    queryModelPivot({
      client,
      source: options.source,
      fieldPolicy: options.fieldPolicy,
      filter: options.filter,
      page: options.page,
      limit: options.limit,
    }),
  );
}

export async function executeInterfacePivot(options: {
  readonly libraryName: string;
  readonly source: Extract<PivotSource, { readonly kind: 'interface' }>;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly accessKey?: string;
  readonly page?: number;
  readonly cursor?: string | null;
  readonly limit?: number;
}): Promise<PivotDocument> {
  return withBusinessLibrarySession(options.libraryName, (client) =>
    invokeInterfacePivot({
      client,
      source: options.source,
      parameters: options.parameters,
      accessKey: options.accessKey,
      page: options.page,
      cursor: options.cursor,
      limit: options.limit,
    }),
  );
}
