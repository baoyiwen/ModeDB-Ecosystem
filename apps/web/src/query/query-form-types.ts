/** 单条 wire-safe 过滤条件（对应 QueryChain.where）。 */
export interface QueryFilterAtom {
  readonly field: string;
  readonly op: string;
  readonly value: unknown;
}

export type QueryHopKind = 'none' | 'relate' | 'group' | 'children' | 'recursive';

export type QueryResultMode = 'rows' | 'analysis';

export interface QueryFormConfig {
  readonly startIds: string;
  readonly filtersJson: string;
  readonly hopKind: QueryHopKind;
  readonly relationForward: string;
  readonly maxDepth: number;
  readonly limit: string;
  readonly page: string;
  readonly includeRelates: boolean;
  readonly resultMode: QueryResultMode;
  readonly groupBy: string;
  readonly computeJson: string;
}

export const QUERY_FORM_LS_PREFIX = 'modedb.playground.query.';

export const DEFAULT_QUERY_FORM: QueryFormConfig = {
  startIds: '',
  filtersJson: '[]',
  hopKind: 'none',
  relationForward: '',
  maxDepth: 5,
  limit: '',
  page: '',
  includeRelates: true,
  resultMode: 'rows',
  groupBy: '',
  computeJson: '{}',
};

export const DEFAULT_QUERY_SNAPSHOT = `{
  "plan": {
    "start": { "model": "<ModelName>", "mode": "rows" },
    "hops": []
  },
  "execute": {
    "includeRelates": true
  },
  "analysis": {
    "groupBy": null,
    "compute": null
  }
}`;
