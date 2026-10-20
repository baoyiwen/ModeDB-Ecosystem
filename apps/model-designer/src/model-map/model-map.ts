import type { EngineModelNode } from '../types/engine-schema.js';
import type { PropObject } from '../types/prop-object.js';
import { resolveI18nForLocale, resolveModelDisplayName } from '../utils/i18n-resolve.js';
import { sortPropsBySort } from '../utils/prop-order.js';

export interface ModelMapField {
  readonly prop: PropObject;
  readonly label: string;
  readonly description: string;
  readonly ownerId: string;
  readonly ownerLabel: string;
}

export interface ModelMapEntry {
  readonly model: EngineModelNode;
  readonly label: string;
  readonly description: string;
  readonly fields: readonly ModelMapField[];
  readonly parent: EngineModelNode | undefined;
  readonly inheritanceIssue: 'cycle' | 'missing-parent' | undefined;
}

export function buildModelMap(models: readonly EngineModelNode[], locale: string): ModelMapEntry[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  return models
    .map((model): ModelMapEntry => {
      const lineage: EngineModelNode[] = [];
      const visited = new Set<string>();
      let current: EngineModelNode | undefined = model;
      let inheritanceIssue: ModelMapEntry['inheritanceIssue'];
      while (current) {
        if (visited.has(current.id)) {
          inheritanceIssue = 'cycle';
          break;
        }
        visited.add(current.id);
        lineage.push(current);
        if (current.parent_id && !byId.has(current.parent_id)) {
          inheritanceIssue = 'missing-parent';
        }
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
      }

      // Hydrated child models may repeat inherited fields; retain the defining ancestor.
      const fields = new Map<string, ModelMapField>();
      for (const owner of lineage.reverse()) {
        for (const prop of sortPropsBySort(owner.props_objects_array)) {
          if (fields.has(prop.name)) continue;
          fields.set(prop.name, {
            prop,
            label: resolveI18nForLocale(prop.name_i18n, locale, prop.name),
            description: resolveI18nForLocale(prop.description_i18n, locale, ''),
            ownerId: owner.id,
            ownerLabel: resolveModelDisplayName(owner, locale),
          });
        }
      }
      return {
        model,
        label: resolveModelDisplayName(model, locale),
        description: resolveI18nForLocale(model.description_i18n, locale, ''),
        fields: [...fields.values()],
        parent: model.parent_id ? byId.get(model.parent_id) : undefined,
        inheritanceIssue,
      };
    })
    .sort(
      (a, b) =>
        collator.compare(a.label, b.label) ||
        collator.compare(a.model.model_name, b.model.model_name),
    );
}

export function matchesModelMapField(field: ModelMapField, search: string): boolean {
  const term = search.trim().toLocaleLowerCase();
  return `${field.label} ${field.prop.name} ${field.description}`
    .toLocaleLowerCase()
    .includes(term);
}

export function filterModelMap(
  entries: readonly ModelMapEntry[],
  search: string,
): readonly ModelMapEntry[] {
  const term = search.trim().toLocaleLowerCase();
  if (!term) return entries;
  return entries.filter(
    (entry) =>
      `${entry.label} ${entry.model.model_name} ${entry.description}`
        .toLocaleLowerCase()
        .includes(term) || entry.fields.some((field) => matchesModelMapField(field, term)),
  );
}
