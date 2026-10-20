import { useId, useMemo, useState, type ReactElement } from 'react';
import type { QueryInterfaceRelease } from '../query-designer/index.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import {
  describePivotInterfaceConditions,
  pivotParameterDefault,
  type PivotConditionNode,
  type PivotParameterDraft,
  type PivotParameterIssue,
} from '../pivot/interface-input.js';
import { useDesigner } from '../context/designer-context.js';
import '../styles/pivot-interface.css';

type Translate = (key: string, values?: Record<string, string>) => string;

function ConditionView(props: {
  node: PivotConditionNode;
  release: QueryInterfaceRelease;
  t: Translate;
}): ReactElement {
  const { node, release, t } = props;
  if (node.kind === 'group')
    return (
      <div className={`pivot-condition-group is-${node.combinator}`}>
        <span className="pivot-condition-logic">{t(`pivotLogic_${node.combinator}`)}</span>
        <div className="pivot-condition-children">
          {node.children.map((child) => (
            <ConditionView key={child.id} node={child} release={release} t={t} />
          ))}
        </div>
      </div>
    );
  if (node.kind === 'relation')
    return (
      <div className="pivot-condition-relation">
        <strong>{node.label}</strong>
        <span>{t(`pivotQuantifier_${node.quantifier}`)}</span>
        {node.condition ? <ConditionView node={node.condition} release={release} t={t} /> : null}
      </div>
    );
  const parameter =
    node.value?.kind === 'parameter'
      ? release.queryInterface.contract.parameters.find(
          (item) => node.value?.kind === 'parameter' && item.id === node.value.parameterId,
        )
      : undefined;
  const unary = ['isNull', 'isNotNull'].includes(node.operator);
  const value =
    node.value?.kind === 'literal'
      ? typeof node.value.value === 'string'
        ? node.value.value
        : JSON.stringify(node.value.value)
      : undefined;
  return (
    <div className="pivot-condition-rule">
      <strong>{node.label}</strong>
      <span>{t(`pivotOperator_${node.operator}`)}</span>
      {!unary ? (
        <code>
          {node.value?.kind === 'parameter'
            ? `${t('pivotParameterReference')}: ${parameter?.label || parameter?.name || node.value.parameterId}`
            : (value ?? '—')}
        </code>
      ) : null}
      <span
        className={`pivot-condition-kind ${node.value?.kind === 'parameter' ? 'is-parameter' : ''}`}
      >
        {t(node.value?.kind === 'parameter' ? 'pivotParameterCondition' : 'pivotFixedCondition')}
      </span>
    </div>
  );
}

export function InterfaceQueryInputs(props: {
  readonly release: QueryInterfaceRelease;
  readonly models: readonly EngineModelNode[];
  readonly relations: readonly EngineRelationEdge[];
  readonly values: PivotParameterDraft;
  readonly issues: readonly PivotParameterIssue[];
  readonly accessKey: string;
  readonly disabled: boolean;
  readonly needsInput: boolean;
  readonly onChange: (values: PivotParameterDraft) => void;
  readonly onAccessKeyChange: (value: string) => void;
}): ReactElement {
  const { i18n } = useDesigner();
  const t: Translate = (key, values) => i18n.t('ui', key, values);
  const id = useId();
  const asset = props.release.queryInterface;
  const [expanded, setExpanded] = useState(props.needsInput);
  const conditions = useMemo(
    () =>
      describePivotInterfaceConditions({
        queryInterface: asset,
        models: props.models,
        relations: props.relations,
        locale: i18n.locale,
      }),
    [asset, props.models, props.relations, i18n.locale],
  );
  const countConditions = (node?: PivotConditionNode): number =>
    !node
      ? 0
      : node.kind === 'group'
        ? node.children.reduce((count, child) => count + countConditions(child), 0)
        : node.kind === 'relation'
          ? 1 + countConditions(node.condition)
          : 1;
  const conditionCount = countConditions(conditions.where) + countConditions(conditions.having);
  return (
    <section className="pivot-interface-inputs" aria-label={t('pivotInterfaceInputs')}>
      <button
        type="button"
        className="pivot-config-toggle"
        aria-expanded={expanded}
        aria-controls={`${id}-configuration`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <strong>{t('pivotQuerySettings')}</strong>
        <span>
          {t('pivotQuerySummary', {
            parameters: String(asset.contract.parameters.length),
            conditions: String(conditionCount),
          })}
        </span>
        {props.needsInput ? (
          <span className="pivot-query-required">{t('pivotFillParameters')}</span>
        ) : null}
      </button>
      <div id={`${id}-configuration`} className="pivot-config-content" hidden={!expanded}>
        <p className="pivot-interface-hint">{t('pivotPublishedRulesHint')}</p>
        {asset.contract.parameters.length ? (
          <div className="pivot-interface-parameters">
            {asset.contract.parameters.map((parameter) => {
              const issue = props.issues.find((item) => item.parameterId === parameter.id);
              const inputId = `${id}-${parameter.id}`;
              const descriptionId = `${inputId}-hint`;
              const errorId = `${inputId}-error`;
              const defaultValue = pivotParameterDefault(parameter);
              const shared = {
                id: inputId,
                className: 'designer-input',
                value: props.values[parameter.id] ?? '',
                disabled: props.disabled,
                'aria-required': parameter.required,
                'aria-invalid': Boolean(issue),
                'aria-describedby': `${descriptionId}${issue ? ` ${errorId}` : ''}`,
                onChange: (event: { target: { value: string } }) =>
                  props.onChange({ ...props.values, [parameter.id]: event.target.value }),
              };
              return (
                <div key={parameter.id} className="pivot-interface-parameter">
                  <label htmlFor={inputId}>
                    <strong>{parameter.label || parameter.name}</strong>
                    {parameter.label && parameter.label !== parameter.name ? (
                      <code>{parameter.name}</code>
                    ) : null}
                    <span
                      className={
                        parameter.required ? 'pivot-parameter-required' : 'pivot-parameter-optional'
                      }
                    >
                      {t(parameter.required ? 'pivotParameterRequired' : 'pivotParameterOptional')}
                    </span>
                    <small>{t(`pivotParameterType_${parameter.type}`)}</small>
                  </label>
                  {parameter.type === 'boolean' ? (
                    <select {...shared}>
                      <option value="">
                        {t(
                          defaultValue === undefined
                            ? 'pivotParameterOmit'
                            : 'pivotParameterUseDefault',
                        )}
                      </option>
                      <option value="true">{t('pivotBooleanTrue')}</option>
                      <option value="false">{t('pivotBooleanFalse')}</option>
                    </select>
                  ) : parameter.type === 'json' ? (
                    <textarea
                      {...shared}
                      className="designer-textarea pivot-parameter-json"
                      placeholder={defaultValue ?? '{ }'}
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      {...shared}
                      type={
                        parameter.type === 'number'
                          ? 'number'
                          : parameter.type === 'date'
                            ? 'date'
                            : parameter.type === 'datetime'
                              ? 'datetime-local'
                              : 'text'
                      }
                      step={
                        parameter.type === 'number'
                          ? 'any'
                          : parameter.type === 'datetime'
                            ? '1'
                            : undefined
                      }
                      placeholder={
                        defaultValue ??
                        (parameter.type === 'datetime' ? '2026-10-17T12:00:00Z' : parameter.name)
                      }
                    />
                  )}
                  <div id={descriptionId} className="pivot-parameter-help">
                    {parameter.description ? <span>{parameter.description}</span> : null}
                    {defaultValue !== undefined ? (
                      <span>{t('pivotParameterDefault', { value: defaultValue })}</span>
                    ) : null}
                    {conditions.parameterTargets.get(parameter.id)?.map((target) => (
                      <span key={target}>{t('pivotParameterTarget', { target })}</span>
                    ))}
                  </div>
                  {issue ? (
                    <span id={errorId} className="pivot-parameter-error" role="alert">
                      {t(`pivotParameterError_${issue.code}`)}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="pivot-interface-hint">{t('pivotNoInterfaceParameters')}</p>
        )}
        {asset.contract.permissions?.mode === 'key' ? (
          <label className="designer-field pivot-interface-key">
            <span className="designer-field-label">{t('pivotInterfaceAccessKey')}</span>
            <input
              className="designer-input"
              type="password"
              autoComplete="off"
              value={props.accessKey}
              disabled={props.disabled}
              onChange={(event) => props.onAccessKeyChange(event.target.value)}
            />
          </label>
        ) : null}
        {props.needsInput ? (
          <p className="pivot-interface-input-hint" role="status">
            {t('pivotFillParameters')}
          </p>
        ) : null}
        <div className="pivot-interface-rules" aria-label={t('pivotPublishedConditions')}>
          <h4>{t('pivotPublishedConditions')}</h4>
          {conditions.where ? (
            <ConditionView node={conditions.where} release={props.release} t={t} />
          ) : (
            <p className="pivot-interface-hint">{t('pivotNoPublishedConditions')}</p>
          )}
          {conditions.having ? (
            <>
              <h4>{t('pivotHavingConditions')}</h4>
              <ConditionView node={conditions.having} release={props.release} t={t} />
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
