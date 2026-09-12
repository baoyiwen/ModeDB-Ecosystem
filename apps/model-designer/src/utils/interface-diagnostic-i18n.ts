import type { I18nManager } from '../managers/i18n-manager.js';

export interface InterfaceDiagnosticLike {
  code: string;
  message: string;
}

export function interfaceDiagnosticMessage(
  i18n: I18nManager,
  issue: InterfaceDiagnosticLike | undefined,
): string | undefined {
  if (!issue) {
    return undefined;
  }

  const exactKey = `interfaceIssue_${issue.code}`;
  const exact = i18n.t('ui', exactKey);
  if (exact !== exactKey) {
    return exact;
  }
  if (i18n.locale === 'en') {
    return issue.message;
  }

  return i18n.t('ui', diagnosticFamilyKey(issue.code));
}

function diagnosticFamilyKey(code: string): string {
  if (code.startsWith('operation_')) {
    if (code.includes('relation')) {
      return 'interfaceIssueOperationRelation';
    }
    if (code.includes('batch')) {
      return 'interfaceIssueOperationBatch';
    }
    if (code.includes('upsert')) {
      return 'interfaceIssueOperationUpsert';
    }
    if (code.includes('parameter')) {
      return 'interfaceIssueOperationParameter';
    }
    if (code.includes('field') || code.includes('mapping')) {
      return 'interfaceIssueOperationField';
    }
    if (code.includes('identity')) {
      return 'interfaceIssueOperationIdentity';
    }
    return 'interfaceIssueOperationConfiguration';
  }

  if (code.startsWith('binding_surface_')) {
    if (code.includes('query_release')) {
      return 'interfaceIssueBindingQuery';
    }
    if (code.includes('operation')) {
      return 'interfaceIssueBindingOperation';
    }
    if (code.includes('mutation')) {
      return 'interfaceIssueBindingMutation';
    }
    if (code.includes('parameter')) {
      return 'interfaceIssueBindingParameter';
    }
    if (code.includes('trigger')) {
      return 'interfaceIssueBindingTrigger';
    }
    if (code.includes('row_') || code.includes('record_ref')) {
      return 'interfaceIssueBindingRow';
    }
    if (code.includes('permission') || code.includes('access_key') || code.includes('rate_limit')) {
      return 'interfaceIssueBindingAccess';
    }
    return 'interfaceIssueBindingConfiguration';
  }

  if (code.startsWith('execution_') || code.startsWith('publication_')) {
    if (code.includes('parameter')) {
      return 'interfaceIssueQueryParameter';
    }
    if (code.includes('filter') || code.includes('having') || code.includes('aggregation')) {
      return 'interfaceIssueQueryFilter';
    }
    if (code.includes('sort') || code.includes('projection')) {
      return 'interfaceIssueQueryResult';
    }
    if (code.includes('edge') || code.includes('relation') || code.includes('root_model')) {
      return 'interfaceIssueQueryGraph';
    }
    return 'interfaceIssueQueryConfiguration';
  }

  return 'interfaceIssueValidationGeneric';
}
