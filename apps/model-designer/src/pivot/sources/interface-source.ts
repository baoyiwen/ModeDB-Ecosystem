import type { QueryInterfaceInvocationResult } from '@mode-db/sdk';
import type { PivotDocument, PivotSource } from '../types.js';
import { normalizePivotResult } from '../normalizer.js';

type InterfacePivotSource = Extract<PivotSource, { readonly kind: 'interface' }>;

export interface PivotInterfaceInvocationOptions {
  readonly client: PivotInterfaceClient;
  readonly source: InterfacePivotSource;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly accessKey?: string;
  readonly page?: number;
  readonly cursor?: string | null;
  readonly limit?: number;
}

/** Minimal SDK surface used by Pivot so invocation can be tested without a socket. */
export interface PivotInterfaceClient {
  invokeQueryInterface(
    callableName: string,
    options?: {
      readonly version?: string;
      readonly parameters?: Readonly<Record<string, unknown>>;
      readonly accessKey?: string;
      readonly page?: number;
      readonly cursor?: string | null;
      readonly limit?: number;
    },
  ): Promise<QueryInterfaceInvocationResult>;
}

/** Execute one published Query Interface and normalize its returned rows. */
export async function invokeInterfacePivot(
  options: PivotInterfaceInvocationOptions,
): Promise<PivotDocument> {
  const result = await options.client.invokeQueryInterface(options.source.callableName, {
    version: options.source.version,
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.accessKey ? { accessKey: options.accessKey } : {}),
    ...(options.page !== undefined ? { page: options.page } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  return normalizePivotResult({
    source: options.source,
    rows: result.rows,
    page: {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      mode:
        options.cursor !== undefined || result.nextCursor
          ? 'cursor'
          : result.page !== undefined
            ? 'offset'
            : 'none',
      ...(result.page !== undefined ? { page: result.page } : {}),
      ...(result.total !== undefined ? { total: result.total } : {}),
      ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    },
  });
}
