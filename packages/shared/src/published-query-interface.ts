import type { RemoteExecuteSnapshot } from './wire-query-plan.js';
import { sha256 } from '@noble/hashes/sha256';

const accessKeyEncoder = new TextEncoder();

export type PublishedQueryParameterType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'json'
  | 'recordRef'
  | 'relationRef';

export interface PublishedQueryParameter {
  readonly id: string;
  readonly name: string;
  readonly type: PublishedQueryParameterType;
  readonly required: boolean;
  readonly defaultValue?: unknown;
}

export interface QueryParameterPlaceholder {
  readonly $queryParameter: string;
}

export interface PublishedQueryRowAdapter {
  readonly kind: 'rows';
  readonly rootNodeId: string;
  readonly fieldsByNode: Readonly<
    Record<string, readonly { readonly sourceField: string; readonly outputName: string }[]>
  >;
  readonly edgesBySource: Readonly<
    Record<
      string,
      readonly {
        readonly toNodeId: string;
        readonly relationName: string;
        readonly outputName: string;
      }[]
    >
  >;
}

export interface PublishedQueryAggregationAdapter {
  readonly kind: 'aggregation';
  readonly dimensions: readonly { readonly sourceField: string; readonly outputName: string }[];
  readonly metrics: readonly { readonly wireKey: string; readonly outputName: string }[];
}

export type PublishedQueryResultAdapter =
  | PublishedQueryRowAdapter
  | PublishedQueryAggregationAdapter;

export interface PublishedQueryExecutionTemplate {
  readonly format: 1;
  readonly snapshot: RemoteExecuteSnapshot;
  readonly parameters: readonly PublishedQueryParameter[];
  readonly resultAdapter: PublishedQueryResultAdapter;
  readonly pagination: {
    readonly mode: 'none' | 'offset' | 'cursor';
    readonly defaultLimit?: number;
    readonly maxLimit?: number;
  };
}

export function queryParameterPlaceholder(parameterId: string): QueryParameterPlaceholder {
  return { $queryParameter: parameterId };
}

export function isQueryParameterPlaceholder(value: unknown): value is QueryParameterPlaceholder {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Partial<QueryParameterPlaceholder>).$queryParameter === 'string'
  );
}

export function queryInterfaceAccessKeyDigest(accessKey: string): string {
  const bytes = sha256(accessKeyEncoder.encode(accessKey));
  let digest = '';
  for (const byte of bytes) {
    digest += byte.toString(16).padStart(2, '0');
  }
  return digest;
}
