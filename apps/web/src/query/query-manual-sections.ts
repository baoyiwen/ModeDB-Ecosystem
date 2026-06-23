import type { MessageKey } from '../i18n/messages.js';

export interface ManualCodeExample {
  readonly captionKey: MessageKey;
  readonly code: string;
}

export interface QueryManualSection {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly paragraphKeys: readonly MessageKey[];
  readonly examples?: readonly ManualCodeExample[];
}

export const QUERY_MANUAL_SECTIONS: readonly QueryManualSection[] = [
  {
    id: 'overview',
    titleKey: 'manual.sOverview.title',
    paragraphKeys: ['manual.sOverview.p1', 'manual.sOverview.p2', 'manual.sOverview.p3'],
  },
  {
    id: 'quickstart',
    titleKey: 'manual.sQuickstart.title',
    paragraphKeys: ['manual.sQuickstart.p1', 'manual.sQuickstart.p2'],
  },
  {
    id: 'start',
    titleKey: 'manual.sStart.title',
    paragraphKeys: ['manual.sStart.p1', 'manual.sStart.p2'],
    examples: [
      {
        captionKey: 'manual.ex.allRows',
        code: `wire.model('Country').query().execute()`,
      },
      {
        captionKey: 'manual.ex.byIds',
        code: `wire.model('Country').query(['jp', 'us']).execute()`,
      },
    ],
  },
  {
    id: 'filters',
    titleKey: 'manual.sFilters.title',
    paragraphKeys: ['manual.sFilters.p1', 'manual.sFilters.p2'],
    examples: [
      {
        captionKey: 'manual.ex.filtersJson',
        code: `[
  { "field": "status", "op": "eq", "value": "active" },
  { "field": "population", "op": "gte", "value": 1000000 },
  { "field": "code", "op": "in", "value": ["JP", "US"] }
]`,
      },
      {
        captionKey: 'manual.ex.filtersChain',
        code: `wire.model('Country')
  .query()
  .where('status', 'eq', 'active')
  .where('population', 'gte', 1_000_000)
  .execute()`,
      },
    ],
  },
  {
    id: 'hops',
    titleKey: 'manual.sHops.title',
    paragraphKeys: ['manual.sHops.p1', 'manual.sHops.p2', 'manual.sHops.p3'],
    examples: [
      {
        captionKey: 'manual.ex.relate',
        code: `// Subject becomes City; follow forward label "cities"
wire.model('Country').query().relate('cities').execute()`,
      },
      {
        captionKey: 'manual.ex.group',
        code: `// Subject stays Country; targets attach under relates
wire.model('Country')
  .query()
  .group('cities')
  .execute({ includeRelates: true })`,
      },
      {
        captionKey: 'manual.ex.children',
        code: `wire.model('Category')
  .query()
  .children('parent', { maxDepth: 3 })
  .execute({ includeRelates: true })`,
      },
      {
        captionKey: 'manual.ex.recursive',
        code: `wire.model('Node')
  .query()
  .relateRecursive('child', { maxDepth: 5 })
  .execute()`,
      },
    ],
  },
  {
    id: 'execute',
    titleKey: 'manual.sExecute.title',
    paragraphKeys: ['manual.sExecute.p1', 'manual.sExecute.p2'],
    examples: [
      {
        captionKey: 'manual.ex.pagination',
        code: `wire.model('Country')
  .query()
  .limit(10)
  .page(0)
  .execute()`,
      },
    ],
  },
  {
    id: 'analysis',
    titleKey: 'manual.sAnalysis.title',
    paragraphKeys: ['manual.sAnalysis.p1', 'manual.sAnalysis.p2'],
    examples: [
      {
        captionKey: 'manual.ex.analysis',
        code: `wire.model('Order')
  .query()
  .groupBy(['region', 'category'])
  .compute({ amount: 'sum', id: 'count' })
  .execute()`,
      },
      {
        captionKey: 'manual.ex.computeJson',
        code: `{ "amount": "sum", "price": ["min", "max"], "id": "count" }`,
      },
    ],
  },
  {
    id: 'snapshot',
    titleKey: 'manual.sSnapshot.title',
    paragraphKeys: ['manual.sSnapshot.p1', 'manual.sSnapshot.p2', 'manual.sSnapshot.p3'],
    examples: [
      {
        captionKey: 'manual.ex.snapshotMinimal',
        code: `{
  "plan": {
    "start": { "model": "Country", "mode": "rows" },
    "hops": []
  },
  "execute": { "includeRelates": true, "limit": 10, "page": 0 },
  "analysis": { "groupBy": null, "compute": null }
}`,
      },
      {
        captionKey: 'manual.ex.snapshotRelate',
        code: `{
  "plan": {
    "start": { "model": "Country", "mode": "rows" },
    "hops": [
      { "kind": "relate", "forward": "cities", "lateral": false }
    ]
  },
  "execute": { "includeRelates": true },
  "analysis": { "groupBy": null, "compute": null }
}`,
      },
      {
        captionKey: 'manual.ex.applyQuery',
        code: `const snapshot = wire
  .model('Country')
  .query()
  .relate('cities')
  .getRemoteExecuteSnapshot({ includeRelates: true });

const result = await wire.apply({ op: 'executeQuery', snapshot });`,
      },
    ],
  },
  {
    id: 'results',
    titleKey: 'manual.sResults.title',
    paragraphKeys: ['manual.sResults.p1', 'manual.sResults.p2'],
    examples: [
      {
        captionKey: 'manual.ex.resultRows',
        code: `{
  "kind": "rows",
  "rows": [
    { "model": "Country", "data": { "_id": "jp", "name": "Japan" } }
  ]
}`,
      },
      {
        captionKey: 'manual.ex.resultPaginated',
        code: `{
  "kind": "paginated",
  "page": 0,
  "total": 42,
  "limit": 10,
  "pageCount": 5,
  "items": { "kind": "rows", "rows": [ ... ] }
}`,
      },
    ],
  },
  {
    id: 'limits',
    titleKey: 'manual.sLimits.title',
    paragraphKeys: ['manual.sLimits.p1', 'manual.sLimits.p2', 'manual.sLimits.p3'],
  },
  {
    id: 'tips',
    titleKey: 'manual.sTips.title',
    paragraphKeys: ['manual.sTips.p1', 'manual.sTips.p2', 'manual.sTips.p3'],
  },
];

export interface ManualTocEntry {
  readonly id: string;
  readonly titleKey: MessageKey;
}

export const MANUAL_TABLE_SECTIONS: readonly ManualTocEntry[] = [
  { id: 'filter-ops', titleKey: 'manual.sFilterOps.title' },
  { id: 'hop-compare', titleKey: 'manual.sHopCompare.title' },
  { id: 'compute-ops', titleKey: 'manual.sComputeOps.title' },
];

export const MANUAL_TOC_ENTRIES: readonly ManualTocEntry[] = [
  ...QUERY_MANUAL_SECTIONS.map((section) => ({
    id: section.id,
    titleKey: section.titleKey,
  })),
  ...MANUAL_TABLE_SECTIONS,
];
