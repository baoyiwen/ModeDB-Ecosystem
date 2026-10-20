import { RemoteModelDBClient } from '@mode-db/sdk';
import type {
  TransferModel,
  TransferPackage,
  TransferPreflight,
  TransferRelation,
} from '@mode-db/data-kit';
import { TransferError } from '@mode-db/data-kit';
import {
  resolveBusinessConnectionParams,
  withBusinessLibrarySession,
} from '../engine/business-library-session.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { QueryInterfaceRelease } from '../query-designer/query-interface-publication.js';
import { buildInterfaceTransfer, interfaceTransferIssues } from './interface-transfer.js';
import { buildModelMap } from '../model-map/model-map.js';
import { normalizeLegacyPropType } from '../config/engine-prop-types.js';
import { resolveI18nForLocale } from '../utils/i18n-resolve.js';
import {
  collectModelTransfer,
  preflightModelTransfer,
  type TransferFilter,
  type TransferNotify,
} from './model-transfer.js';
import { transferSheetName } from './sheet-name.js';

export async function currentSchema(
  database: string,
  models: readonly EngineModelNode[],
  locale: string,
): Promise<{ models: TransferModel[]; relations: readonly TransferRelation[] }> {
  const catalog = await RemoteModelDBClient.getDatabaseCatalog({
    ...resolveBusinessConnectionParams(),
    database,
  });
  const entries = buildModelMap(models, locale);
  const used = new Set(['history', '_modedb', '_relations', '_paths']);
  return {
    models: catalog.models
      .filter((model) => !model.name.startsWith('sys_'))
      .map((model) => {
        const entry = entries.find((item) => item.model.model_name === model.name);
        return {
          name: model.name,
          label: resolveI18nForLocale(model.displayName, locale, entry?.label ?? model.name),
          sheet: transferSheetName(model.name, used),
          fields: model.fields
            .filter((name) => !name.startsWith('_'))
            .map((name) => {
              const prop = entry?.fields.find((field) => field.prop.name === name)?.prop;
              return {
                name,
                label: resolveI18nForLocale(
                  model.fieldLabels?.[name],
                  locale,
                  resolveI18nForLocale(prop?.name_i18n, locale, name),
                ),
                type: model.fieldTypes?.[name] ?? normalizeLegacyPropType(prop?.type),
                required: prop?.is_required,
              };
            }),
        };
      }),
    relations: catalog.relations,
  };
}

export async function loadModelTransferSchema(input: {
  readonly database: string;
  readonly modelName: string;
  readonly models: readonly EngineModelNode[];
  readonly locale: string;
}): Promise<{ model: TransferModel; relations: readonly TransferRelation[]; ancestors: string[] }> {
  const schema = await currentSchema(input.database, input.models, input.locale);
  const live = schema.models.find((model) => model.name === input.modelName);
  const designed = buildModelMap(input.models, input.locale).find(
    (item) => item.model.model_name === input.modelName,
  );
  if (!live || !designed || designed.inheritanceIssue) throw new TransferError('model');
  const names = new Set(designed.fields.map((field) => field.prop.name));
  const model = { ...live, fields: live.fields.filter((field) => names.has(field.name)) };
  const ancestors: string[] = [];
  let parent = designed.parent;
  while (parent) {
    ancestors.push(parent.model_name);
    const parentId = parent.parent_id;
    parent = input.models.find((candidate) => candidate.id === parentId);
  }
  return { model, relations: schema.relations, ancestors };
}

export async function exportModelTransfer(input: {
  readonly database: string;
  readonly modelName: string;
  readonly models: readonly EngineModelNode[];
  readonly locale: string;
  readonly filters: readonly TransferFilter[];
  readonly template: boolean;
  readonly includeRelations?: boolean;
  readonly signal?: AbortSignal;
  readonly notify?: TransferNotify;
}): Promise<TransferPackage> {
  const { model, relations, ancestors } = await loadModelTransferSchema(input);
  return withBusinessLibrarySession(input.database, (client) =>
    collectModelTransfer({ ...input, client, model, relations, ancestors }),
  );
}

export async function validateModelTransfer(input: {
  readonly database: string;
  readonly data: TransferPackage;
  readonly models: readonly EngineModelNode[];
  readonly locale: string;
  readonly signal?: AbortSignal;
  readonly notify?: TransferNotify;
}): Promise<TransferPreflight> {
  const schema = await currentSchema(input.database, input.models, input.locale);
  return withBusinessLibrarySession(input.database, (client) =>
    preflightModelTransfer({ ...input, ...schema, client }),
  );
}

export async function validateInterfaceTransfer(input: {
  readonly database: string;
  readonly data: TransferPackage;
  readonly release: QueryInterfaceRelease;
  readonly models: readonly EngineModelNode[];
  readonly relations: readonly EngineRelationEdge[];
  readonly locale: string;
  readonly signal?: AbortSignal;
  readonly notify?: TransferNotify;
}): Promise<TransferPreflight> {
  const allowed = buildInterfaceTransfer({ ...input, template: true });
  const issues = interfaceTransferIssues(input.data, allowed, input.release, input.models);
  const schema = await currentSchema(input.database, input.models, input.locale);
  const result = await withBusinessLibrarySession(input.database, (client) =>
    preflightModelTransfer({ ...input, ...schema, client }),
  );
  return {
    ...result,
    issues: [...issues, ...result.issues],
    valid: result.valid && issues.length === 0,
  };
}

/** Read only schema metadata; result values still come exclusively from the interface. */
export async function exportInterfaceTransfer(
  input: Parameters<typeof buildInterfaceTransfer>[0],
): Promise<TransferPackage> {
  const schema = await currentSchema(input.database, input.models, input.locale);
  return buildInterfaceTransfer({ ...input, schema: schema.models });
}
