import { securityReleaseDigest, type SecurityGrant } from '@mode-db/sdk';
import type { QueryInterfaceRelease } from './query-interface-publication.js';
import type { InterfaceParameter } from './types.js';

export type InterfaceCallAuthMode = 'registry' | 'legacy';

function parameterExample(parameter: InterfaceParameter): unknown {
  if (parameter.defaultValue !== undefined) return parameter.defaultValue;
  switch (parameter.type) {
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'json':
      return {};
    case 'date':
      return '2026-01-01';
    case 'datetime':
      return '2026-01-01T00:00:00.000Z';
    default:
      return `<${parameter.name}>`;
  }
}

/** Examples describe the published contract, never a caller's credentials or draft. */
export function publishedInterfaceCallBody(
  release: QueryInterfaceRelease,
): Record<string, unknown> {
  const pagination = release.queryInterface.query.pagination;
  return {
    version: release.version,
    parameters: Object.fromEntries(
      release.queryInterface.contract.parameters.map((parameter) => [
        parameter.name,
        parameterExample(parameter),
      ]),
    ),
    ...(release.queryInterface.contract.permissions?.mode === 'key'
      ? { accessKey: '<ACCESS_KEY>' }
      : {}),
    ...(pagination?.mode === 'offset' ? { page: 0 } : {}),
    ...(pagination?.mode === 'cursor' ? { cursor: null } : {}),
    ...(pagination?.mode !== 'none' && pagination?.defaultLimit
      ? { limit: pagination.defaultLimit }
      : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildInterfaceCallDocs(input: {
  release: QueryInterfaceRelease;
  libraryCode: string;
  baseUrl: string;
  authMode: InterfaceCallAuthMode;
}) {
  const { release, libraryCode, authMode } = input;
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const path = `/api/v1/databases/${encodeURIComponent(libraryCode)}/query-interfaces/${encodeURIComponent(release.callableName)}`;
  const endpoint = `${baseUrl}${path}`;
  const body = publishedInterfaceCallBody(release);
  const rawBody = JSON.stringify(body, null, 2);
  const registry = authMode === 'registry';
  const authHeader = registry
    ? 'Authorization: Bearer $MODELDB_TOKEN'
    : 'X-ModelDB-Connect-Token: $MODELDB_CONNECT_TOKEN';
  const curl = [
    `curl --fail-with-body --request POST ${shellQuote(endpoint)}`,
    `  --header 'Content-Type: application/json'`,
    `  --header "${authHeader}"`,
    `  --data-raw ${shellQuote(rawBody)}`,
  ].join(' \\\n');
  const grant: SecurityGrant = {
    database: libraryCode,
    resource: release.callableName,
    actions: ['callable.query'],
    releaseDigest: securityReleaseDigest(release),
  };
  const postman = {
    info: {
      name: `${libraryCode} / ${release.callableName} @ ${release.version}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: baseUrl, type: 'string' },
      { key: registry ? 'modeldbToken' : 'connectToken', value: '', type: 'string' },
    ],
    item: [
      {
        name: release.callableName,
        protocolProfileBehavior: { followRedirects: false },
        request: {
          method: 'POST',
          auth: registry
            ? {
                type: 'bearer',
                bearer: [{ key: 'token', value: '{{modeldbToken}}', type: 'string' }],
              }
            : { type: 'noauth' },
          header: [
            { key: 'Content-Type', value: 'application/json' },
            ...(!registry ? [{ key: 'X-ModelDB-Connect-Token', value: '{{connectToken}}' }] : []),
          ],
          url: `{{baseUrl}}${path}`,
          body: { mode: 'raw', raw: rawBody, options: { raw: { language: 'json' } } },
        },
      },
    ],
  };
  return { endpoint, body, curl, postman, grant: registry ? grant : undefined };
}
