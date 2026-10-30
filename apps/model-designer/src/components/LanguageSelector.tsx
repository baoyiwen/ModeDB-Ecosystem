import { useEffect, useState, type ReactElement } from 'react';
import { useDesigner } from '../context/designer-context.js';
import type { LocaleCode } from '../managers/i18n-manager.js';

/** Language is a display preference; changing it never reconnects or authorizes a session. */
export function LanguageSelector(): ReactElement {
  const { i18n } = useDesigner();
  const [, redraw] = useState(0);
  useEffect(() => i18n.subscribe(() => redraw((value) => value + 1)), [i18n]);

  return (
    <label className="designer-language-selector">
      <span>{i18n.t('ui', 'locale')}</span>
      <select
        className="designer-select"
        value={i18n.locale}
        onChange={(event) => i18n.setLocale(event.target.value as LocaleCode)}
      >
        {(['en', 'zh', 'ja'] as const).map((locale) => (
          <option key={locale} value={locale} lang={locale}>
            {i18n.t('ui', `languageName_${locale}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
