import type {
  QueryFilter,
  QueryFilterExpression,
  QueryFilterGroup,
  QueryRelationFilter,
} from './types.js';

export const QUERY_FILTER_ROOT_ID = 'filter_root';

export function createQueryFilterRoot(filters: readonly QueryFilter[] = []): QueryFilterGroup {
  return {
    id: QUERY_FILTER_ROOT_ID,
    kind: 'group',
    combinator: 'and',
    enabled: true,
    children: filters.map((filter) => ({ ...filter })),
  };
}

export function cloneQueryFilterGroup(group: QueryFilterGroup): QueryFilterGroup {
  return {
    ...group,
    children: group.children.map((child) => {
      if (isQueryFilterGroup(child)) {
        return cloneQueryFilterGroup(child);
      }
      if (isQueryRelationFilter(child)) {
        return {
          ...child,
          target: { ...child.target },
          condition: cloneQueryFilterGroup(child.condition),
        };
      }
      return { ...child };
    }),
  };
}

export function queryFilterTreeFromSpec(
  group: QueryFilterGroup | undefined,
  filters: readonly QueryFilter[],
): QueryFilterGroup {
  return group ? cloneQueryFilterGroup(group) : createQueryFilterRoot(filters);
}

export function flattenQueryFilterTree(group: QueryFilterGroup): QueryFilter[] {
  return group.children.flatMap((child) => {
    if (isQueryFilterGroup(child)) {
      return flattenQueryFilterTree(child);
    }
    if (isQueryRelationFilter(child)) {
      return flattenQueryFilterTree(child.condition);
    }
    return [{ ...child }];
  });
}

export function queryFilterGroupCount(group: QueryFilterGroup): number {
  return (
    1 +
    group.children.reduce(
      (count, child) =>
        count +
        (isQueryFilterGroup(child)
          ? queryFilterGroupCount(child)
          : isQueryRelationFilter(child)
            ? queryFilterGroupCount(child.condition)
            : 0),
      0,
    )
  );
}

export function queryFilterExpressionCount(group: QueryFilterGroup): number {
  return group.children.reduce((count, child) => {
    if (isQueryFilterGroup(child)) {
      return count + queryFilterExpressionCount(child);
    }
    if (isQueryRelationFilter(child)) {
      return count + 1 + queryFilterExpressionCount(child.condition);
    }
    return count + 1;
  }, 0);
}

export function queryRelationFilterCount(group: QueryFilterGroup): number {
  return group.children.reduce((count, child) => {
    if (isQueryFilterGroup(child)) {
      return count + queryRelationFilterCount(child);
    }
    if (isQueryRelationFilter(child)) {
      return count + 1 + queryRelationFilterCount(child.condition);
    }
    return count;
  }, 0);
}

export function mapQueryFilterTree(
  group: QueryFilterGroup,
  mapper: (filter: QueryFilter) => QueryFilter,
): QueryFilterGroup {
  return {
    ...group,
    children: group.children.map((child) => {
      if (isQueryFilterGroup(child)) {
        return mapQueryFilterTree(child, mapper);
      }
      if (isQueryRelationFilter(child)) {
        return { ...child, condition: mapQueryFilterTree(child.condition, mapper) };
      }
      return mapper(child);
    }),
  };
}

export function updateQueryFilterExpression(
  group: QueryFilterGroup,
  id: string,
  updater: (expression: QueryFilterExpression) => QueryFilterExpression,
): QueryFilterGroup {
  if (group.id === id) {
    const updated = updater(group);
    return isQueryFilterGroup(updated) ? updated : group;
  }
  return {
    ...group,
    children: group.children.map((child) => {
      if (child.id === id) {
        return updater(child);
      }
      if (isQueryFilterGroup(child)) {
        return updateQueryFilterExpression(child, id, updater);
      }
      if (isQueryRelationFilter(child)) {
        return {
          ...child,
          condition: updateQueryFilterExpression(child.condition, id, updater),
        };
      }
      return child;
    }),
  };
}

export function appendQueryFilterExpression(
  group: QueryFilterGroup,
  groupId: string,
  expression: QueryFilterExpression,
): QueryFilterGroup {
  return updateQueryFilterExpression(group, groupId, (current) =>
    isQueryFilterGroup(current)
      ? { ...current, children: [...current.children, expression] }
      : current,
  );
}

export function removeQueryFilterExpression(group: QueryFilterGroup, id: string): QueryFilterGroup {
  return {
    ...group,
    children: group.children
      .filter((child) => child.id !== id)
      .map((child) =>
        isQueryFilterGroup(child)
          ? removeQueryFilterExpression(child, id)
          : isQueryRelationFilter(child)
            ? { ...child, condition: removeQueryFilterExpression(child.condition, id) }
            : child,
      ),
  };
}

export function isQueryFilterGroup(
  expression: QueryFilterExpression,
): expression is QueryFilterGroup {
  return 'kind' in expression && expression.kind === 'group';
}

export function isQueryRelationFilter(
  expression: QueryFilterExpression,
): expression is QueryRelationFilter {
  return 'kind' in expression && expression.kind === 'relation';
}
