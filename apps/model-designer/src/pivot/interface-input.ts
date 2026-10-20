import type {
  InterfaceParameter,
  QueryFieldRef,
  QueryFilterExpression,
  QueryFilterOperator,
  QueryFilterValue,
  QueryInterface,
} from '../query-designer/types.js';
import {
  isQueryFilterGroup,
  isQueryRelationFilter,
  queryFilterTreeFromSpec,
} from '../query-designer/query-filter-tree.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import { buildModelMap } from '../model-map/model-map.js';
import { resolveRelationForwardLabel, resolveRelationReverseLabel } from '../utils/i18n-resolve.js';
import { isValidDateOnly, toStoredDateTime } from './date-time.js';

export type PivotParameterDraft = Readonly<Record<string, string>>;
export interface PivotParameterIssue {
  readonly parameterId: string;
  readonly code: 'required' | 'number' | 'boolean' | 'json' | 'date' | 'datetime';
}

/** Blank fields are omitted so the published runtime, including defaults, stays authoritative. */
export function preparePivotParameters(
  parameters: readonly InterfaceParameter[],
  draft: PivotParameterDraft,
): { values: Readonly<Record<string, unknown>>; issues: readonly PivotParameterIssue[] } {
  const entries: [string, unknown][] = [];
  const issues: PivotParameterIssue[] = [];
  for (const parameter of parameters) {
    const text = draft[parameter.id] ?? '';
    if (text === '') {
      if (
        parameter.required &&
        (parameter.defaultValue === undefined || parameter.defaultValue === '')
      )
        issues.push({ parameterId: parameter.id, code: 'required' });
      continue;
    }
    let value: unknown = text;
    const invalid = (code: PivotParameterIssue['code']): void => {
      issues.push({ parameterId: parameter.id, code });
    };
    if (parameter.type === 'number') {
      value = Number(text);
      if (!text.trim() || !Number.isFinite(value)) {
        invalid('number');
        continue;
      }
    } else if (parameter.type === 'boolean') {
      if (text !== 'true' && text !== 'false') {
        invalid('boolean');
        continue;
      }
      value = text === 'true';
    } else if (
      parameter.type === 'json' ||
      (['recordRef', 'relationRef'].includes(parameter.type) && /^[\s]*[\[{]/.test(text))
    ) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        invalid('json');
        continue;
      }
    } else if (parameter.type === 'date') {
      if (!isValidDateOnly(text)) {
        invalid('date');
        continue;
      }
    } else if (parameter.type === 'datetime') {
      const stored = toStoredDateTime(text);
      if (!stored || !/[T ]\d{2}:\d{2}/.test(text)) {
        invalid('datetime');
        continue;
      }
      // Local picker input is interpreted in the user's timezone; explicit
      // offsets are normalized to the same canonical UTC wire representation.
      value = stored;
    }
    entries.push([parameter.name, value]);
  }
  return { values: Object.fromEntries(entries), issues };
}

export function pivotParameterDefault(parameter: InterfaceParameter): string | undefined {
  if (parameter.defaultValue === undefined) return undefined;
  return typeof parameter.defaultValue === 'string'
    ? parameter.defaultValue
    : JSON.stringify(parameter.defaultValue);
}

export type PivotConditionNode =
  | {
      readonly kind: 'group';
      readonly id: string;
      readonly combinator: 'and' | 'or';
      readonly children: readonly PivotConditionNode[];
    }
  | {
      readonly kind: 'relation';
      readonly id: string;
      readonly label: string;
      readonly quantifier: 'any' | 'all' | 'none';
      readonly condition?: PivotConditionNode;
    }
  | {
      readonly kind: 'rule';
      readonly id: string;
      readonly label: string;
      readonly operator: QueryFilterOperator;
      readonly value?: QueryFilterValue;
    };

/** Preserve boolean groups, relation quantifiers and node aliases, including repeated models. */
export function describePivotInterfaceConditions(input: {
  readonly queryInterface: QueryInterface;
  readonly models: readonly EngineModelNode[];
  readonly relations: readonly EngineRelationEdge[];
  readonly locale: string;
}): {
  where?: PivotConditionNode;
  having?: PivotConditionNode;
  parameterTargets: ReadonlyMap<string, readonly string[]>;
} {
  const asset = input.queryInterface;
  const entries = buildModelMap(input.models, input.locale);
  const targets = new Map<string, string[]>();
  const labelTarget = (target: QueryFieldRef): string => {
    const node = asset.designGraph.nodes.find((item) => item.id === target.nodeId);
    const entry = entries.find(
      (item) => item.model.id === target.modelId || item.model.model_name === target.modelId,
    );
    const field = entry?.fields.find(
      (item) => item.prop.id === target.fieldId || item.prop.name === target.fieldId,
    );
    const modelLabel = entry?.label ?? target.modelId;
    return `${modelLabel}${node?.alias ? ` [${node.alias}]` : ''} · ${field?.label ?? target.fieldId}`;
  };
  const visit = (expression: QueryFilterExpression): PivotConditionNode | undefined => {
    if (!expression.enabled) return undefined;
    if (isQueryFilterGroup(expression)) {
      const children = expression.children
        .map(visit)
        .filter((child): child is PivotConditionNode => child !== undefined);
      return children.length
        ? { kind: 'group', id: expression.id, combinator: expression.combinator, children }
        : undefined;
    }
    if (isQueryRelationFilter(expression)) {
      const edge = asset.designGraph.edges.find((item) => item.id === expression.target.edgeId);
      const relation = input.relations.find((item) => item.id === expression.target.relationId);
      const label = relation
        ? edge?.traversal === 'reverse'
          ? resolveRelationReverseLabel(relation, input.locale)
          : resolveRelationForwardLabel(relation, input.locale)
        : (edge?.alias ?? expression.target.relationId);
      return {
        kind: 'relation',
        id: expression.id,
        label: `${label}${edge?.alias ? ` [${edge.alias}]` : ''}`,
        quantifier: expression.quantifier,
        condition: visit(expression.condition),
      };
    }
    const target = expression.target;
    const label =
      'nodeId' in target
        ? labelTarget(target)
        : 'metricId' in target
          ? (asset.query.aggregation?.metrics.find((metric) => metric.id === target.metricId)
              ?.outputName ?? target.metricId)
          : target.relationId;
    if (expression.value?.kind === 'parameter') {
      const id = expression.value.parameterId;
      targets.set(id, [...new Set([...(targets.get(id) ?? []), label])]);
    }
    return {
      kind: 'rule',
      id: expression.id,
      label,
      operator: expression.operator,
      value: expression.value,
    };
  };
  const where = visit(queryFilterTreeFromSpec(asset.query.filterTree, asset.query.filters));
  const having = asset.query.aggregation?.having
    ? visit(asset.query.aggregation.having)
    : undefined;
  return { where, having, parameterTargets: targets };
}
