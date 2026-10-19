import { Button } from '@dork-labs/ui';
import type { CommunityWireSignInMark } from '@dorkos/shared/community-wire';
import { DorkMark, GitHubMark, GoogleMark } from '@dorkos/icons/marks';
import { KeyRound } from 'lucide-react';
import type { Ref } from 'react';

/** A provider the host offers beside email and password. */
export type SignInProvider = 'google' | 'github' | 'oidc';

/** The mark a provider's button shows: the brand's own, or a neutral key for any other issuer. */
function ProviderMark({
  provider,
  mark,
}: {
  provider: SignInProvider;
  mark: CommunityWireSignInMark | null;
}) {
  if (provider === 'google') return <GoogleMark size={18} />;
  if (provider === 'github') return <GitHubMark size={18} />;
  if (mark === 'dorkos') return <DorkMark size={18} />;
  return <KeyRound size={18} aria-hidden="true" data-mark="key" />;
}

/**
 * One "Continue with <name>" button, styled like the provider sign-in buttons people know: a
 * neutral bordered surface, the provider's mark at the start and the name centred. Every
 * sign-in page uses this one button, so they all look alike.
 */
export function ProviderButton({
  provider,
  label,
  mark = null,
  disabled,
  onClick,
  ref,
}: {
  provider: SignInProvider;
  /** The provider's name, as the button says it. */
  label: string;
  /** For the host's single sign-on, the mark the host named; ignored for Google and GitHub. */
  mark?: CommunityWireSignInMark | null;
  disabled: boolean;
  onClick: () => void;
  /** The button, for a page that moves focus to it. */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Button
      ref={ref}
      variant="outline"
      type="button"
      className="relative w-full px-10"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="absolute left-3 inline-flex items-center">
        <ProviderMark provider={provider} mark={mark} />
      </span>
      Continue with {label}
    </Button>
  );
}
