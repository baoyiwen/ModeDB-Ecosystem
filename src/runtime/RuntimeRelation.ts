import type { RelationDefinition, RelationLogic, MatchPredicate } from '../../common/types.js';

/**
 * Read-only relation metadata (no bind / index mutation).
 */
export class RuntimeRelation {
  protected readonly def: RelationDefinition;

  constructor(def: RelationDefinition) {
    this.def = def;
  }

  get sourceModel(): string {
    return this.def.source;
  }

  get targetModel(): string {
    return this.def.target;
  }

  get forwardName(): string {
    return this.def.forward;
  }

  get reverseName(): string {
    return this.def.reverse;
  }

  get logic(): RelationLogic | null {
    return this.def.logic;
  }

  get matchOn(): MatchPredicate | null {
    return this.def.matchOn;
  }

  getDefinition(): RelationDefinition {
    return this.def;
  }
}
