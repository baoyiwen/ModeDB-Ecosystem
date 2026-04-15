import { ModelDBClient } from '../facade/client.js';
import { AuthoringEngine, type AuthoringEngineOptions } from './engine.js';

/**
 * Full authoring entry point (admin / back-office): registration, inserts, indexing.
 *
 * Use {@link ModelDBAdmin.client} to obtain a {@link ModelDBClient} for query-only embedding.
 */
export class ModelDBAdmin extends AuthoringEngine {
  constructor(options: AuthoringEngineOptions = { atlas: 'default' }) {
    super(options);
  }

  client(): ModelDBClient {
    return ModelDBClient.fromContext(this.createRuntime());
  }
}
