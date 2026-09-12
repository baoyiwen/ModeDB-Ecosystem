export type QueryInterfaceErrorCategory =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'runtime';

export interface QueryInterfaceErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly category: QueryInterfaceErrorCategory;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string>>;
}

export function queryInterfaceErrorDetailFromMessage(
  message: string,
): QueryInterfaceErrorDetail | undefined {
  const [code, ...parts] = message.split(':');
  if (!code?.startsWith('INTERFACE_')) {
    return undefined;
  }
  const values = parts.filter(Boolean);
  const details = detailsForCode(code, values);
  return {
    code,
    message,
    category: categoryForCode(code),
    retryable: code === 'INTERFACE_REGISTRY_UNAVAILABLE' || code === 'INTERFACE_RATE_LIMITED',
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

export function isQueryInterfaceErrorDetail(value: unknown): value is QueryInterfaceErrorDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const detail = value as Partial<QueryInterfaceErrorDetail>;
  return (
    typeof detail.code === 'string' &&
    detail.code.startsWith('INTERFACE_') &&
    typeof detail.message === 'string' &&
    typeof detail.category === 'string' &&
    typeof detail.retryable === 'boolean'
  );
}

function categoryForCode(code: string): QueryInterfaceErrorCategory {
  if (
    code === 'INTERFACE_RELEASE_NOT_FOUND' ||
    code === 'INTERFACE_BINDING_SURFACE_RELEASE_NOT_FOUND' ||
    code === 'INTERFACE_BINDING_MUTATION_NOT_FOUND'
  ) {
    return 'not_found';
  }
  if (
    code === 'INTERFACE_RELEASE_AMBIGUOUS' ||
    code === 'INTERFACE_BINDING_SURFACE_RELEASE_AMBIGUOUS'
  ) {
    return 'conflict';
  }
  if (code === 'INTERFACE_REGISTRY_UNAVAILABLE') {
    return 'unavailable';
  }
  if (
    code === 'INTERFACE_ACCESS_KEY_REQUIRED' ||
    code === 'INTERFACE_ACCESS_DENIED' ||
    code === 'INTERFACE_ACCESS_DISABLED'
  ) {
    return 'forbidden';
  }
  if (code === 'INTERFACE_RATE_LIMITED') {
    return 'rate_limited';
  }
  if (code.startsWith('INTERFACE_RESULT_')) {
    return 'runtime';
  }
  return 'validation';
}

function detailsForCode(code: string, values: readonly string[]): Record<string, string> {
  if (code === 'INTERFACE_RELEASE_NOT_FOUND') {
    const [callableName = '', version = ''] = (values[0] ?? '').split('@');
    return {
      ...(callableName ? { callableName } : {}),
      ...(version ? { version } : {}),
    };
  }
  if (code === 'INTERFACE_BINDING_SURFACE_RELEASE_NOT_FOUND') {
    const [surfaceId = '', version = ''] = (values[0] ?? '').split('@');
    return {
      ...(surfaceId ? { surfaceId } : {}),
      ...(version ? { version } : {}),
    };
  }
  if (code === 'INTERFACE_BINDING_MUTATION_NOT_FOUND') {
    return values[0] ? { mutationId: values[0] } : {};
  }
  if (code === 'INTERFACE_RELEASE_AMBIGUOUS') {
    return values[0] ? { callableName: values[0] } : {};
  }
  if (code === 'INTERFACE_BINDING_SURFACE_RELEASE_AMBIGUOUS') {
    return values[0] ? { surfaceId: values[0] } : {};
  }
  if (
    code === 'INTERFACE_PARAMETER_REQUIRED' ||
    code === 'INTERFACE_PARAMETER_UNKNOWN' ||
    code === 'INTERFACE_PARAMETER_INVALID'
  ) {
    return {
      ...(values[0] ? { parameter: values[0] } : {}),
      ...(values[1] ? { expectedType: values[1] } : {}),
    };
  }
  if (code === 'INTERFACE_RATE_LIMITED') {
    return values[0] ? { retryAfterSeconds: values[0] } : {};
  }
  return {};
}
