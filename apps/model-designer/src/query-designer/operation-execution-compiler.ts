import type { PublishedOperationExecutionTemplate } from '@mode-db/sdk';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type {
  OperationInputMapping,
  OperationInputRole,
  OperationInterface,
  OperationTarget,
  QueryFieldRef,
} from './types.js';

export interface OperationExecutionDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

export interface PublishedOperationTemplateCompilation {
  template?: PublishedOperationExecutionTemplate;
  diagnostics: OperationExecutionDiagnostic[];
}

function interfaceParameterPlaceholder(parameterId: string): {
  readonly $interfaceParameter: string;
} {
  return { $interfaceParameter: parameterId };
}

/**
 * Compiles single-record and single-relation-pair OperationInterface execution templates.
 */
export function compilePublishedOperationExecutionTemplate(input: {
  operationInterface: OperationInterface;
  models: readonly EngineModelNode[];
  relations?: readonly EngineRelationEdge[];
}): PublishedOperationTemplateCompilation {
  const diagnostics: OperationExecutionDiagnostic[] = [];
  const addDiagnostic = (diagnostic: OperationExecutionDiagnostic): void => {
    if (
      !diagnostics.some(
        (current) => current.code === diagnostic.code && current.path === diagnostic.path,
      )
    ) {
      diagnostics.push(diagnostic);
    }
  };
  const asset = input.operationInterface;
  const parametersById = new Map(
    asset.contract.parameters.map((parameter) => [parameter.id, parameter]),
  );
  const nodesById = new Map(asset.designGraph.nodes.map((node) => [node.id, node]));
  const modelsById = new Map(input.models.map((model) => [model.id, model]));
  if (asset.operation.operationType === 'batch') {
    return compileBatchOperation(input);
  }
  if (isRelationshipOperation(asset.operation.operationType)) {
    return compileRelationshipOperation({
      asset,
      modelsById,
      relations: input.relations ?? [],
      parametersById,
      diagnostics,
      addDiagnostic,
    });
  }
  const targetModelId = operationTargetModelId(asset.operation.target, nodesById);
  const targetModel = targetModelId ? modelsById.get(targetModelId) : undefined;

  if (!targetModelId) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_target_unsupported',
      message: 'The first OperationInterface execution slice supports model and node targets.',
      path: 'operation.target',
    });
  } else if (!targetModel?.model_name) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_model_missing',
      message: `Target model "${targetModelId}" is unavailable in the current catalog.`,
      path: 'operation.target',
    });
  }

  if (asset.operation.operationType === 'upsert') {
    return compileUpsertOperation({
      asset,
      targetModelId,
      targetModel,
      parametersById,
      diagnostics,
      addDiagnostic,
    });
  }

  if (!['create', 'update', 'delete'].includes(asset.operation.operationType)) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_type_unsupported',
      message: `Operation type "${asset.operation.operationType}" is not supported by this execution slice.`,
      path: 'operation.operationType',
    });
  }

  const fieldValues: Record<string, unknown> = {};
  const identityMappings: OperationInputMapping[] = [];
  for (const mapping of asset.operation.inputMapping) {
    const path = `operation.inputMapping.${mapping.parameterId}`;
    if (!parametersById.has(mapping.parameterId)) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_parameter_missing',
        message: `Input mapping references missing parameter "${mapping.parameterId}".`,
        path,
      });
      continue;
    }
    if (mapping.mode === 'lookup' && isOperationTarget(mapping.target)) {
      if (!sameOperationTarget(mapping.target, asset.operation.target)) {
        addDiagnostic({
          severity: 'error',
          code: 'operation_execution_identity_target_mismatch',
          message: 'The identity lookup must target the operation target.',
          path,
        });
      } else {
        identityMappings.push(mapping);
      }
      continue;
    }
    if (mapping.mode !== 'set' || !isFieldRef(mapping.target)) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_mapping_unsupported',
        message: 'Record operations support field set mappings and one target identity lookup.',
        path,
      });
      continue;
    }
    const fieldTarget = mapping.target;
    if (fieldTarget.modelId !== targetModelId) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_field_model_mismatch',
        message: 'Mapped fields must belong to the operation target model.',
        path,
      });
      continue;
    }
    const prop = targetModel?.props_objects_array.find(
      (candidate) => candidate.id === fieldTarget.fieldId,
    );
    if (!prop?.name) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_field_missing',
        message: `Mapped field "${fieldTarget.fieldId}" is unavailable on the target model.`,
        path,
      });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(fieldValues, prop.name)) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_field_duplicate',
        message: `Target field "${prop.name}" is mapped more than once.`,
        path,
      });
      continue;
    }
    fieldValues[prop.name] = interfaceParameterPlaceholder(mapping.parameterId);
  }

  const needsIdentity =
    asset.operation.operationType === 'update' || asset.operation.operationType === 'delete';
  if (needsIdentity && identityMappings.length !== 1) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_identity_required',
      message: 'Update and delete operations require exactly one target identity lookup.',
      path: 'operation.inputMapping',
    });
  }
  if (!needsIdentity && identityMappings.length > 0) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_identity_not_allowed',
      message: 'Create operations cannot provide a target identity lookup.',
      path: 'operation.inputMapping',
    });
  }
  if (asset.operation.operationType === 'update' && Object.keys(fieldValues).length === 0) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_update_empty',
      message: 'Update operations require at least one field mapping.',
      path: 'operation.inputMapping',
    });
  }
  if (asset.operation.operationType === 'delete' && Object.keys(fieldValues).length > 0) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_delete_fields_not_allowed',
      message: 'Delete operations cannot contain field mappings.',
      path: 'operation.inputMapping',
    });
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error') || !targetModel) {
    return { diagnostics };
  }
  const identity = identityMappings[0]
    ? interfaceParameterPlaceholder(identityMappings[0].parameterId)
    : undefined;
  let operation: PublishedOperationExecutionTemplate['operation'];
  if (asset.operation.operationType === 'create') {
    operation = { op: 'insert', model: targetModel.model_name, data: fieldValues, sync: true };
  } else if (asset.operation.operationType === 'update') {
    operation = {
      op: 'update',
      model: targetModel.model_name,
      id: identity,
      partial: fieldValues,
      sync: true,
    };
  } else {
    operation = { op: 'delete', model: targetModel.model_name, id: identity, sync: true };
  }
  return {
    diagnostics,
    template: {
      format: 1,
      operation,
      parameters: asset.contract.parameters.map((parameter) => ({
        id: parameter.id,
        name: parameter.name,
        type: parameter.type,
        required: parameter.required,
        ...(parameter.defaultValue !== undefined ? { defaultValue: parameter.defaultValue } : {}),
      })),
      result: { returns: asset.operation.result.returns },
    },
  };
}

function compileBatchOperation(input: {
  operationInterface: OperationInterface;
  models: readonly EngineModelNode[];
  relations?: readonly EngineRelationEdge[];
}): PublishedOperationTemplateCompilation {
  const asset = input.operationInterface;
  const diagnostics: OperationExecutionDiagnostic[] = [];
  const batch = asset.operation.batch;
  if (!batch) {
    diagnostics.push({
      severity: 'error',
      code: 'operation_execution_batch_spec_required',
      message: 'Batch operations require an item operation type and maximum item count.',
      path: 'operation.batch',
    });
    return { diagnostics };
  }
  if (
    asset.operation.transactionPolicy.mode !== 'batch' ||
    asset.operation.transactionPolicy.rollbackOnFailure
  ) {
    diagnostics.push({
      severity: 'error',
      code: 'operation_execution_batch_transaction_unsupported',
      message:
        'Batch execution supports non-atomic batch mode only; cross-item rollback is unavailable.',
      path: 'operation.transactionPolicy',
    });
  }
  if (!['continue', 'stop'].includes(asset.operation.transactionPolicy.failureMode ?? '')) {
    diagnostics.push({
      severity: 'error',
      code: 'operation_execution_batch_failure_mode_required',
      message: 'Batch execution requires an explicit continue or stop failure mode.',
      path: 'operation.transactionPolicy.failureMode',
    });
  }
  if (!Number.isInteger(batch.maxItems) || batch.maxItems < 1 || batch.maxItems > 1000) {
    diagnostics.push({
      severity: 'error',
      code: 'operation_execution_batch_limit_invalid',
      message: 'Batch maximum item count must be an integer between 1 and 1000.',
      path: 'operation.batch.maxItems',
    });
  }
  if (asset.operation.result.returns !== 'summary') {
    diagnostics.push({
      severity: 'error',
      code: 'operation_execution_batch_result_invalid',
      message: 'Batch operations return the stable batch summary contract.',
      path: 'operation.result.returns',
    });
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { diagnostics };
  }
  const itemInterface: OperationInterface = {
    ...asset,
    operation: {
      ...asset.operation,
      operationType: batch.itemOperationType,
      batch: undefined,
      transactionPolicy: { mode: 'single', rollbackOnFailure: true },
      result: { returns: 'summary' },
    },
  };
  const itemCompilation = compilePublishedOperationExecutionTemplate({
    operationInterface: itemInterface,
    models: input.models,
    relations: input.relations,
  });
  diagnostics.push(...itemCompilation.diagnostics);
  if (
    !itemCompilation.template ||
    diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  ) {
    return { diagnostics };
  }
  return {
    diagnostics,
    template: {
      ...itemCompilation.template,
      batch: {
        itemsParameter: 'items',
        maxItems: batch.maxItems,
        failureMode: asset.operation.transactionPolicy.failureMode!,
      },
      transaction: { mode: 'batch', rollbackOnFailure: false },
      result: {
        returns: 'summary',
        includeItemResults: asset.operation.result.includeItemResults === true,
      },
    },
  };
}

function compileUpsertOperation(input: {
  asset: OperationInterface;
  targetModelId: string | undefined;
  targetModel: EngineModelNode | undefined;
  parametersById: ReadonlyMap<string, OperationInterface['contract']['parameters'][number]>;
  diagnostics: OperationExecutionDiagnostic[];
  addDiagnostic: (diagnostic: OperationExecutionDiagnostic) => void;
}): PublishedOperationTemplateCompilation {
  const fieldValues: Record<string, unknown> = {};
  const setParameterByField = new Map<string, string>();
  const matchFields: string[] = [];
  for (const mapping of input.asset.operation.inputMapping) {
    const path = `operation.inputMapping.${mapping.parameterId}`;
    if (!input.parametersById.has(mapping.parameterId)) {
      input.addDiagnostic({
        severity: 'error',
        code: 'operation_execution_parameter_missing',
        message: `Input mapping references missing parameter "${mapping.parameterId}".`,
        path,
      });
      continue;
    }
    if (!isFieldRef(mapping.target) || !['set', 'lookup'].includes(mapping.mode)) {
      input.addDiagnostic({
        severity: 'error',
        code: 'operation_execution_upsert_mapping_invalid',
        message: 'Upsert operations support field set mappings and field lookup mappings.',
        path,
      });
      continue;
    }
    const fieldTarget = mapping.target;
    if (fieldTarget.modelId !== input.targetModelId) {
      input.addDiagnostic({
        severity: 'error',
        code: 'operation_execution_field_model_mismatch',
        message: 'Mapped fields must belong to the operation target model.',
        path,
      });
      continue;
    }
    const prop = input.targetModel?.props_objects_array.find(
      (candidate) => candidate.id === fieldTarget.fieldId,
    );
    if (!prop?.name) {
      input.addDiagnostic({
        severity: 'error',
        code: 'operation_execution_field_missing',
        message: `Mapped field "${fieldTarget.fieldId}" is unavailable on the target model.`,
        path,
      });
      continue;
    }
    if (mapping.mode === 'set') {
      if (setParameterByField.has(prop.name)) {
        input.addDiagnostic({
          severity: 'error',
          code: 'operation_execution_field_duplicate',
          message: `Target field "${prop.name}" is mapped more than once.`,
          path,
        });
        continue;
      }
      setParameterByField.set(prop.name, mapping.parameterId);
      fieldValues[prop.name] = interfaceParameterPlaceholder(mapping.parameterId);
      continue;
    }
    if (matchFields.includes(prop.name)) {
      input.addDiagnostic({
        severity: 'error',
        code: 'operation_execution_upsert_match_duplicate',
        message: `Match field "${prop.name}" is mapped more than once.`,
        path,
      });
      continue;
    }
    matchFields.push(prop.name);
  }
  if (Object.keys(fieldValues).length === 0) {
    input.addDiagnostic({
      severity: 'error',
      code: 'operation_execution_upsert_fields_required',
      message: 'Upsert operations require at least one field set mapping.',
      path: 'operation.inputMapping',
    });
  }
  if (matchFields.length === 0) {
    input.addDiagnostic({
      severity: 'error',
      code: 'operation_execution_upsert_match_required',
      message: 'Upsert operations require at least one match field lookup.',
      path: 'operation.inputMapping',
    });
  }
  for (const matchField of matchFields) {
    const matchMapping = input.asset.operation.inputMapping.find((mapping) => {
      if (mapping.mode !== 'lookup' || !isFieldRef(mapping.target)) return false;
      const fieldTarget = mapping.target;
      return (
        input.targetModel?.props_objects_array.find(
          (candidate) => candidate.id === fieldTarget.fieldId,
        )?.name === matchField
      );
    });
    if (setParameterByField.get(matchField) !== matchMapping?.parameterId) {
      input.addDiagnostic({
        severity: 'error',
        code: 'operation_execution_upsert_match_not_set',
        message: `Match field "${matchField}" must use the same parameter as its set mapping.`,
        path: 'operation.inputMapping',
      });
    }
  }
  if (
    input.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ||
    !input.targetModel
  ) {
    return { diagnostics: input.diagnostics };
  }
  return {
    diagnostics: input.diagnostics,
    template: {
      format: 1,
      operation: {
        op: 'insertMany',
        model: input.targetModel.model_name,
        rows: [fieldValues],
        sync: true,
        returning: true,
        upsert: { matchFields, updateExisting: true },
      },
      parameters: input.asset.contract.parameters.map((parameter) => ({
        id: parameter.id,
        name: parameter.name,
        type: parameter.type,
        required: parameter.required,
        ...(parameter.defaultValue !== undefined ? { defaultValue: parameter.defaultValue } : {}),
      })),
      result: { returns: input.asset.operation.result.returns },
    },
  };
}

function compileRelationshipOperation(input: {
  asset: OperationInterface;
  modelsById: ReadonlyMap<string, EngineModelNode>;
  relations: readonly EngineRelationEdge[];
  parametersById: ReadonlyMap<string, OperationInterface['contract']['parameters'][number]>;
  diagnostics: OperationExecutionDiagnostic[];
  addDiagnostic: (diagnostic: OperationExecutionDiagnostic) => void;
}): PublishedOperationTemplateCompilation {
  const { asset, addDiagnostic } = input;
  const relationId = operationTargetRelationId(asset.operation.target, asset.designGraph.edges);
  const relation = relationId
    ? input.relations.find((candidate) => candidate.id === relationId)
    : undefined;
  if (!relationId) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_relation_target_required',
      message: 'Relationship operations require a relation or edge target.',
      path: 'operation.target',
    });
  } else if (!relation) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_relation_missing',
      message: `Target relation "${relationId}" is unavailable in the current catalog.`,
      path: 'operation.target',
    });
  }
  if (relation?.kind === 'modelInherits') {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_inheritance_relation_forbidden',
      message: 'Inheritance edges cannot be mutated as business relationships.',
      path: 'operation.target',
    });
  }
  const sourceModel = relation ? input.modelsById.get(relation.source_model_id) : undefined;
  const targetModel = relation ? input.modelsById.get(relation.target_model_id) : undefined;
  if (relation && (!sourceModel?.model_name || !targetModel?.model_name)) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_relation_model_missing',
      message: 'Both registered relation endpoint models must exist in the current catalog.',
      path: 'operation.target',
    });
  }
  const forward = relation?.engine_forward_name?.trim();
  const reverse = relation?.engine_reverse_name?.trim();
  if (relation && (!forward || !reverse)) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_relation_engine_names_missing',
      message: 'Relationship execution requires stable engine forward and reverse names.',
      path: 'operation.target',
    });
  }
  if (!['summary', 'none'].includes(asset.operation.result.returns)) {
    addDiagnostic({
      severity: 'error',
      code: 'operation_execution_relation_result_invalid',
      message: 'Relationship operations can return only summary or none.',
      path: 'operation.result.returns',
    });
  }

  const mappings = new Map<OperationInputRole, OperationInputMapping>();
  for (const mapping of asset.operation.inputMapping) {
    const path = `operation.inputMapping.${mapping.parameterId}`;
    if (!input.parametersById.has(mapping.parameterId)) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_parameter_missing',
        message: `Input mapping references missing parameter "${mapping.parameterId}".`,
        path,
      });
    }
    if (!mapping.role || !isRelationInputRole(mapping.role)) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_relation_role_required',
        message: 'Every relationship input mapping requires an explicit endpoint role.',
        path,
      });
      continue;
    }
    if (
      !isOperationTarget(mapping.target) ||
      !sameOperationTarget(mapping.target, asset.operation.target)
    ) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_relation_mapping_target_mismatch',
        message: 'Relationship endpoint mappings must target the selected relation.',
        path,
      });
      continue;
    }
    if (mappings.has(mapping.role)) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_relation_role_duplicate',
        message: `Relationship endpoint role "${mapping.role}" is mapped more than once.`,
        path,
      });
      continue;
    }
    mappings.set(mapping.role, mapping);
  }

  const requiredRoles: OperationInputRole[] =
    asset.operation.operationType === 'rebind'
      ? ['relationSource', 'relationPreviousTarget', 'relationNextTarget']
      : ['relationSource', 'relationTarget'];
  for (const role of requiredRoles) {
    if (!mappings.has(role)) {
      addDiagnostic({
        severity: 'error',
        code: 'operation_execution_relation_role_missing',
        message: `Relationship operation requires the "${role}" input role.`,
        path: 'operation.inputMapping',
      });
    }
  }
  if (
    input.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ||
    !sourceModel ||
    !targetModel ||
    !forward ||
    !reverse
  ) {
    return { diagnostics: input.diagnostics };
  }

  const ref = (role: OperationInputRole, model: string) => ({
    model,
    id: interfaceParameterPlaceholder(mappings.get(role)!.parameterId),
  });
  const source = ref('relationSource', sourceModel.model_name);
  let operation: PublishedOperationExecutionTemplate['operation'];
  if (asset.operation.operationType === 'rebind') {
    operation = {
      op: 'rebindPair',
      forward,
      reverse,
      source,
      previousTarget: ref('relationPreviousTarget', targetModel.model_name),
      nextTarget: ref('relationNextTarget', targetModel.model_name),
    };
  } else {
    operation = {
      op: asset.operation.operationType === 'bind' ? 'bindPair' : 'unlinkPair',
      forward,
      reverse,
      source,
      target: ref('relationTarget', targetModel.model_name),
    };
  }
  return {
    diagnostics: input.diagnostics,
    template: {
      format: 1,
      operation,
      parameters: asset.contract.parameters.map((parameter) => ({
        id: parameter.id,
        name: parameter.name,
        type: parameter.type,
        required: parameter.required,
        ...(parameter.defaultValue !== undefined ? { defaultValue: parameter.defaultValue } : {}),
      })),
      result: { returns: asset.operation.result.returns },
    },
  };
}

function operationTargetRelationId(
  target: OperationTarget,
  edges: readonly { id: string; relationId: string }[],
): string | undefined {
  if (target.kind === 'relation') return target.relationId;
  if (target.kind === 'edge') return edges.find((edge) => edge.id === target.edgeId)?.relationId;
  return undefined;
}

function isRelationshipOperation(
  operationType: OperationInterface['operation']['operationType'],
): operationType is 'bind' | 'unbind' | 'rebind' {
  return operationType === 'bind' || operationType === 'unbind' || operationType === 'rebind';
}

function isRelationInputRole(role: OperationInputRole): boolean {
  return role !== 'recordIdentity';
}

function operationTargetModelId(
  target: OperationTarget,
  nodesById: ReadonlyMap<string, { modelId: string }>,
): string | undefined {
  if (target.kind === 'model') {
    return target.modelId;
  }
  if (target.kind === 'node') {
    return nodesById.get(target.nodeId)?.modelId;
  }
  return undefined;
}

function isFieldRef(target: OperationInputMapping['target']): target is QueryFieldRef {
  return 'fieldId' in target;
}

function isOperationTarget(target: OperationInputMapping['target']): target is OperationTarget {
  return 'kind' in target;
}

function sameOperationTarget(left: OperationTarget, right: OperationTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'model' && right.kind === 'model') {
    return left.modelId === right.modelId;
  }
  if (left.kind === 'node' && right.kind === 'node') {
    return left.nodeId === right.nodeId;
  }
  if (left.kind === 'relation' && right.kind === 'relation') {
    return left.relationId === right.relationId;
  }
  return left.kind === 'edge' && right.kind === 'edge' && left.edgeId === right.edgeId;
}
