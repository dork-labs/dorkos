/**
 * The name and web address fields both hosted-community forms share.
 *
 * @module features/community-hosting/ui/community-fields
 */
import { useId } from 'react';
import { Input, Label } from '@/layers/shared/ui';
import { COMMUNITY_NAME_MAX, WEB_ADDRESS_HINT } from '../model/hosting-copy';
import type { WebAddressStatus } from '../model/use-start-community';

/** Props for {@link CommunityFields}. */
export interface CommunityFieldsProps {
  name: string;
  onNameChange: (name: string) => void;
  webAddress: string;
  onWebAddressChange: (webAddress: string) => void;
  /** What the advisory check says about the web address. */
  webAddressStatus: WebAddressStatus;
  /** A refusal from the service that belongs on the web address field. */
  webAddressError: string | null;
  disabled: boolean;
}

/** The words under the web address field for one status, or `null` for none. */
function statusLine(status: WebAddressStatus): { text: string; error: boolean } | null {
  switch (status.kind) {
    case 'invalid':
      return { text: WEB_ADDRESS_HINT, error: true };
    case 'checking':
      return { text: 'Checking…', error: false };
    case 'available':
      return { text: 'That web address is free.', error: false };
    case 'taken':
      return { text: 'That web address is taken.', error: true };
    case 'reserved':
      return { text: 'That web address can’t be used.', error: true };
    default:
      return null;
  }
}

/** Name (required) and web address (optional), with the address grammar as a hint. */
export function CommunityFields(props: CommunityFieldsProps) {
  const id = useId();
  const line = props.webAddressError
    ? { text: props.webAddressError, error: true }
    : statusLine(props.webAddressStatus);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-name`}>Community name</Label>
        <Input
          id={`${id}-name`}
          required
          maxLength={COMMUNITY_NAME_MAX}
          autoComplete="off"
          value={props.name}
          disabled={props.disabled}
          onChange={(event) => props.onNameChange(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-address`}>
          Web address <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id={`${id}-address`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          placeholder="book-club"
          value={props.webAddress}
          disabled={props.disabled}
          aria-invalid={line?.error || undefined}
          aria-describedby={`${id}-address-hint`}
          onChange={(event) => props.onWebAddressChange(event.target.value)}
        />
        <p
          id={`${id}-address-hint`}
          aria-live="polite"
          className={line?.error ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}
        >
          {line?.text ?? WEB_ADDRESS_HINT}
        </p>
      </div>
    </div>
  );
}
