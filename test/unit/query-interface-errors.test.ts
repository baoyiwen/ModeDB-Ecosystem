import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isQueryInterfaceErrorDetail,
  queryInterfaceErrorDetailFromMessage,
} from '@mode-db/shared';

describe('QueryInterface error contract', () => {
  it('classifies required parameters as validation errors', () => {
    const detail = queryInterfaceErrorDetailFromMessage(
      'INTERFACE_PARAMETER_REQUIRED:category',
    );
    assert.deepEqual(detail, {
      code: 'INTERFACE_PARAMETER_REQUIRED',
      message: 'INTERFACE_PARAMETER_REQUIRED:category',
      category: 'validation',
      retryable: false,
      details: { parameter: 'category' },
    });
  });

  it('extracts callable name and version from missing releases', () => {
    const detail = queryInterfaceErrorDetailFromMessage(
      'INTERFACE_RELEASE_NOT_FOUND:itemsByCategory@2.0.0',
    );
    assert.equal(detail?.category, 'not_found');
    assert.deepEqual(detail?.details, {
      callableName: 'itemsByCategory',
      version: '2.0.0',
    });
  });

  it('extracts binding surface and mutation identifiers', () => {
    const release = queryInterfaceErrorDetailFromMessage(
      'INTERFACE_BINDING_SURFACE_RELEASE_NOT_FOUND:item-editor@2.0.0',
    );
    assert.equal(release?.category, 'not_found');
    assert.deepEqual(release?.details, {
      surfaceId: 'item-editor',
      version: '2.0.0',
    });

    const mutation = queryInterfaceErrorDetailFromMessage(
      'INTERFACE_BINDING_MUTATION_NOT_FOUND:update-name',
    );
    assert.equal(mutation?.category, 'not_found');
    assert.deepEqual(mutation?.details, { mutationId: 'update-name' });
  });

  it('ignores unrelated RPC errors and validates structured details', () => {
    assert.equal(queryInterfaceErrorDetailFromMessage('DATABASE_NOT_FOUND'), undefined);
    assert.equal(
      isQueryInterfaceErrorDetail({
        code: 'INTERFACE_REGISTRY_UNAVAILABLE',
        message: 'INTERFACE_REGISTRY_UNAVAILABLE',
        category: 'unavailable',
        retryable: true,
      }),
      true,
    );
  });

  it('classifies access policy failures as forbidden', () => {
    const detail = queryInterfaceErrorDetailFromMessage('INTERFACE_ACCESS_DENIED');
    assert.equal(detail?.category, 'forbidden');
    assert.equal(detail?.retryable, false);
  });

  it('classifies rate limits as retryable and exposes the retry delay', () => {
    const detail = queryInterfaceErrorDetailFromMessage('INTERFACE_RATE_LIMITED:12');
    assert.equal(detail?.category, 'rate_limited');
    assert.equal(detail?.retryable, true);
    assert.deepEqual(detail?.details, { retryAfterSeconds: '12' });
  });
});
