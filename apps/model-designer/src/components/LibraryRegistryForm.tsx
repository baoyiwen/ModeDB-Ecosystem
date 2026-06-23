import type { ReactElement } from 'react';
import { I18nLocaleRows } from './i18n-locale-rows.js';
import { filterUniqueNameInput, isValidUniqueName } from '../utils/name-validation.js';

export interface LibraryRegistryFormProps {
  readonly code: string;
  readonly codeReadOnly: boolean;
  readonly name: Record<string, string>;
  readonly description: Record<string, string>;
  readonly disabled?: boolean;
  readonly codeLabel: string;
  readonly codePlaceholder: string;
  readonly codeInvalidHint: string;
  readonly displayNameLabel: string;
  readonly descriptionLabel: string;
  readonly pickLocaleLabel: string;
  readonly addRowHint: string;
  readonly onCodeChange: (code: string) => void;
  readonly onNameCommit: (next: Record<string, string>) => void;
  readonly onDescriptionCommit: (next: Record<string, string>) => void;
}

/** 逻辑库基本信息：唯一 `code`、i18n 显示名与描述。 */
export function LibraryRegistryForm(props: LibraryRegistryFormProps): ReactElement {
  const {
    code,
    codeReadOnly,
    name,
    description,
    disabled = false,
    codeLabel,
    codePlaceholder,
    codeInvalidHint,
    displayNameLabel,
    descriptionLabel,
    pickLocaleLabel,
    addRowHint,
    onCodeChange,
    onNameCommit,
    onDescriptionCommit,
  } = props;

  const codeInvalid = code.length > 0 && !isValidUniqueName(code);

  return (
    <div
      className="designer-library-form"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <label className="designer-field">
        <span className="designer-field-label">{codeLabel}</span>
        <input
          className="designer-input"
          disabled={disabled || codeReadOnly}
          readOnly={codeReadOnly}
          value={code}
          placeholder={codePlaceholder}
          onChange={(e) => onCodeChange(filterUniqueNameInput(e.target.value))}
        />
        {codeInvalid ? (
          <span style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{codeInvalidHint}</span>
        ) : null}
      </label>

      <I18nLocaleRows
        disabled={disabled}
        summary={displayNameLabel}
        value={name}
        onCommit={onNameCommit}
        pickLocaleLabel={pickLocaleLabel}
        addRowHint={addRowHint}
      />

      <I18nLocaleRows
        disabled={disabled}
        multiline
        summary={descriptionLabel}
        value={description}
        onCommit={onDescriptionCommit}
        pickLocaleLabel={pickLocaleLabel}
        addRowHint={addRowHint}
      />
    </div>
  );
}
