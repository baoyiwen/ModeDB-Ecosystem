import type {
  PublishedBindingSurfaceContract,
  PublishedBindingSurfaceMutation,
} from '@mode-db/data-kit';

export function surfaceMutationById(
  contract: PublishedBindingSurfaceContract,
  mutationId: string | undefined,
): PublishedBindingSurfaceMutation | undefined {
  return mutationId
    ? contract.writeback.mutations.find((mutation) => mutation.id === mutationId)
    : undefined;
}

export function surfaceUpdateMutation(
  contract: PublishedBindingSurfaceContract,
  fieldPath: string,
  mutationId?: string,
): PublishedBindingSurfaceMutation | undefined {
  const selected = surfaceMutationById(contract, mutationId);
  if (selected) {
    return selected.trigger.kind === 'update' ? selected : undefined;
  }
  return contract.writeback.mutations.find(
    (mutation) => mutation.trigger.kind === 'update' && mutation.trigger.fieldPath === fieldPath,
  );
}

export function surfaceDeleteMutation(
  contract: PublishedBindingSurfaceContract,
  mutationId?: string,
): PublishedBindingSurfaceMutation | undefined {
  const selected = surfaceMutationById(contract, mutationId);
  if (selected) {
    return selected.trigger.kind === 'delete' ? selected : undefined;
  }
  return contract.writeback.mutations.find((mutation) => mutation.trigger.kind === 'delete');
}

export function surfaceRelationMutations(
  contract: PublishedBindingSurfaceContract,
): readonly PublishedBindingSurfaceMutation[] {
  return contract.writeback.mutations.filter(
    (mutation) =>
      mutation.trigger.kind === 'bind' ||
      mutation.trigger.kind === 'unbind' ||
      mutation.trigger.kind === 'rebind',
  );
}

export function mutationUsesEditedValue(mutation: PublishedBindingSurfaceMutation): boolean {
  return mutation.parameterBindings.some((binding) => binding.source.kind === 'editedValue');
}

export function formatSurfaceValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function coerceSurfaceValue(raw: string, previous: unknown): unknown {
  if (typeof previous === 'number' && raw.trim() !== '') {
    const value = Number(raw);
    return Number.isNaN(value) ? raw : value;
  }
  if (typeof previous === 'boolean') {
    return raw === 'true' || raw === '1';
  }
  if (previous !== null && typeof previous === 'object') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}
