import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { ConnectionKeyForm } from './ConnectionKeyForm';

/**
 * Entering one of your own keys, with everything that must come before it:
 * where sign-ins will live, in the server's own words, said BEFORE anyone
 * pastes a key; the server's reason when a saved key was refused; and the one
 * hint Composio needs. Shared by the first-connect step and Settings ›
 * Connections, so both say the same thing about the same key.
 */
export function KeyEntry({ status }: { status: ConnectorProviderStatus }) {
  return (
    <div data-testid={`provider-card-${status.type}`} className="space-y-2">
      <p className="text-muted-foreground text-xs leading-relaxed">{status.disclosure}</p>
      {status.error && (
        <p
          role="alert"
          className="text-destructive border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2 text-xs leading-relaxed"
        >
          {status.error}
        </p>
      )}
      {status.type === 'composio' && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Use the project key from your Composio dashboard. An account key, like the one the
          composio command-line tool uses, signs in to apps but can’t run their actions.
        </p>
      )}
      <ConnectionKeyForm type={status.type} submitLabel="Save key" />
    </div>
  );
}
