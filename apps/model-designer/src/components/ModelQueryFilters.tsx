import { useId, useState, type ReactElement } from 'react';
import type { TransferModel } from '@mode-db/data-kit';
import { transferFilterOperators, type TransferFilter } from '../data-transfer/filters.js';
import { useDesigner } from '../context/designer-context.js';
import { DesignerSelect } from './base/designer-select.js';

export function ModelQueryFilters(props: {
  readonly schema?: TransferModel;
  readonly filters: readonly TransferFilter[];
  readonly disabled: boolean;
  readonly onChange: (filters: readonly TransferFilter[]) => void;
}): ReactElement {
  const { i18n } = useDesigner();
  const id = useId();
  const [expanded, setExpanded] = useState(props.filters.length > 0);
  const t = (key: string): string => i18n.t('ui', key);
  const fields =
    props.schema?.fields.filter((field) =>
      ['String', 'I18N', 'Int', 'Number', 'Boolean', 'DateTime', 'JSON', 'Color', 'Unit'].includes(
        field.type,
      ),
    ) ?? [];
  return (
    <section className="pivot-query-filters" aria-label={t('transferConditions')}>
      <div className="data-transfer-section-heading">
        <button
          type="button"
          className="pivot-config-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <strong>{t('transferConditions')}</strong>
          <span>
            {i18n.t('ui', 'pivotConditionCount', { count: String(props.filters.length) })}
          </span>
        </button>
        <button
          type="button"
          className="designer-btn"
          disabled={props.disabled || !fields.length}
          data-unavailable={!fields.length}
          onClick={() => {
            setExpanded(true);
            props.onChange([
              ...props.filters,
              {
                field: fields[0]!.name,
                op: transferFilterOperators(fields[0]!.type)[0]!,
                value: '',
                locale: i18n.locale,
                join: 'and',
              },
            ]);
          }}
        >
          {t('transferAddFilter')}
        </button>
      </div>
      <div id={id} className="pivot-config-content" hidden={!expanded}>
        {!props.filters.length ? (
          <p className="data-transfer-muted">{t('transferAllRows')}</p>
        ) : null}
        {props.filters.map((filter, index) => {
          const type = fields.find((field) => field.name === filter.field)?.type ?? 'String';
          const ops = ['JSON', 'Unit'].includes(type)
            ? (['isNull', 'isNotNull'] as const)
            : transferFilterOperators(type);
          const change = (patch: Partial<TransferFilter>): void =>
            props.onChange(
              props.filters.map((item, position) =>
                position === index ? { ...item, ...patch } : item,
              ),
            );
          return (
            <div className="data-transfer-filter" key={index}>
              {index ? (
                <select
                  className="designer-input"
                  aria-label={t('transferConditionJoin')}
                  disabled={props.disabled}
                  value={filter.join ?? 'and'}
                  onChange={(event) => change({ join: event.target.value as 'and' | 'or' })}
                >
                  <option value="and">{t('transferAnd')}</option>
                  <option value="or">{t('transferOr')}</option>
                </select>
              ) : (
                <span>{t('transferWhere')}</span>
              )}
              <DesignerSelect
                value={filter.field}
                options={fields.map((field) => ({
                  value: field.name,
                  label: field.label === field.name ? field.name : `${field.label} [${field.name}]`,
                }))}
                onChange={(field) =>
                  change({
                    field,
                    op: ['JSON', 'Unit'].includes(
                      fields.find((item) => item.name === field)?.type ?? '',
                    )
                      ? 'isNull'
                      : 'eq',
                    value: '',
                    valueTo: '',
                    locale: i18n.locale,
                  })
                }
                disabled={props.disabled}
              />
              <DesignerSelect
                value={filter.op}
                options={ops.map((op) => ({ value: op, label: t(`transferOp_${op}`) }))}
                onChange={(op) => change({ op: op as TransferFilter['op'] })}
                disabled={props.disabled}
              />
              <div className="data-transfer-filter-values">
                {['isNull', 'isNotNull'].includes(filter.op) ? (
                  <span className="data-transfer-muted">{t('transferNoValueNeeded')}</span>
                ) : type === 'Boolean' ? (
                  <select
                    className="designer-input"
                    aria-label={t('transferFilterValue')}
                    value={filter.value}
                    disabled={props.disabled}
                    onChange={(event) => change({ value: event.target.value })}
                  >
                    <option value="">{t('transferSelectValue')}</option>
                    <option value="true">{t('pivotBooleanTrue')}</option>
                    <option value="false">{t('pivotBooleanFalse')}</option>
                  </select>
                ) : (
                  <>
                    {type === 'I18N' ? (
                      <select
                        className="designer-input"
                        aria-label={t('pivotLanguageMode')}
                        value={filter.locale ?? i18n.locale}
                        disabled={props.disabled}
                        onChange={(event) => change({ locale: event.target.value })}
                      >
                        {[...new Set([i18n.locale, 'zh', 'en', 'ja'])].map((locale) => (
                          <option key={locale} value={locale}>
                            {locale}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <input
                      className="designer-input"
                      type={
                        type === 'DateTime'
                          ? 'datetime-local'
                          : ['Number', 'Int'].includes(type)
                            ? 'number'
                            : type === 'Color'
                              ? 'color'
                              : 'text'
                      }
                      step={type === 'Int' ? '1' : type === 'DateTime' ? '1' : 'any'}
                      aria-label={t('transferFilterValue')}
                      value={filter.value}
                      placeholder={t('transferFilterValue')}
                      disabled={props.disabled}
                      onChange={(event) => change({ value: event.target.value })}
                    />
                    {filter.op === 'between' ? (
                      <input
                        className="designer-input"
                        type={type === 'DateTime' ? 'datetime-local' : 'number'}
                        step={type === 'Int' ? '1' : type === 'DateTime' ? '1' : 'any'}
                        aria-label={t('transferFilterValueTo')}
                        value={filter.valueTo ?? ''}
                        disabled={props.disabled}
                        onChange={(event) => change({ valueTo: event.target.value })}
                      />
                    ) : null}
                  </>
                )}
              </div>
              <button
                type="button"
                className="designer-btn"
                aria-label={`${t('transferRemove')} ${index + 1}`}
                disabled={props.disabled}
                onClick={() =>
                  props.onChange(props.filters.filter((_, position) => position !== index))
                }
              >
                {t('transferRemove')}
              </button>
            </div>
          );
        })}
        <p className="data-transfer-muted">{t('transferPreviewHint')}</p>
        {props.filters.some((filter) => filter.join === 'or') ? (
          <p className="data-transfer-muted">{t('transferLogicHint')}</p>
        ) : null}
      </div>
    </section>
  );
}
