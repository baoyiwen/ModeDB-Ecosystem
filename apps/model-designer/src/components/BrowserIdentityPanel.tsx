import { BrowserIdentityPanel as IdentityPanel } from '@mode-db/data-ui';
import { browserIdentityIssue, createBrowserIdentityClient } from '@mode-db/sdk';
import { useDesigner } from '../context/designer-context.js';

const createClient = () =>
  createBrowserIdentityClient({ host: location.origin, port: Number(location.port) || 443 });
export function BrowserIdentityPanel({
  onContinue,
  connecting,
}: {
  onContinue: () => void;
  connecting: boolean;
}) {
  const { i18n } = useDesigner();
  return (
    <IdentityPanel
      createClient={createClient}
      issueFor={browserIdentityIssue}
      translate={(key) => i18n.t('ui', 'identity_' + key)}
      locale={i18n.locale}
      onContinue={onContinue}
      connecting={connecting}
    />
  );
}
