import type { LocalBrowserCapabilities } from '@dorkos/shared/local-browser';
import type { Ref } from 'react';
import { Input } from '@/layers/shared/ui';

/** Permission is for the chosen personal browser; no logins or tabs are copied. */
export function ExistingBrowserSetup({
  channel,
  onChannelChange,
  consent,
  onConsentChange,
  capabilities,
  disabled = false,
  consentRef,
}: {
  channel: 'chrome' | 'msedge';
  onChannelChange: (channel: 'chrome' | 'msedge') => void;
  consent: boolean;
  onConsentChange: (consent: boolean) => void;
  capabilities: LocalBrowserCapabilities;
  disabled?: boolean;
  consentRef?: Ref<HTMLInputElement>;
}) {
  const setup = capabilities.existingSetup.find((entry) => entry.channel === channel);
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        Choose your browser
        <select
          className="bg-background mt-1 block w-full rounded-md p-2"
          value={channel}
          disabled={disabled}
          onChange={(event) => onChannelChange(event.target.value as 'chrome' | 'msedge')}
        >
          <option value="chrome">Chrome</option>
          <option value="msedge">Edge</option>
        </select>
      </label>
      {setup && (
        <label htmlFor="local-browser-setup-address" className="block space-y-1 text-xs">
          Copy this address into your browser.
          <Input
            id="local-browser-setup-address"
            aria-label="Browser setup address"
            readOnly
            value={setup.address}
            onFocus={(event) => event.target.select()}
          />
        </label>
      )}
      {setup && (
        <ol className="text-muted-foreground list-inside list-decimal space-y-2 text-xs">
          {setup.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      <p className="text-muted-foreground text-xs">Your browser asks before DorkOS can use it.</p>
      <p className="text-muted-foreground text-xs">
        Choose the tab your agent uses after connecting.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          ref={consentRef}
          checked={consent}
          disabled={disabled}
          onChange={(event) => onConsentChange(event.target.checked)}
          className="mt-1"
        />
        Allow DorkOS to use this browser
      </label>
    </div>
  );
}
