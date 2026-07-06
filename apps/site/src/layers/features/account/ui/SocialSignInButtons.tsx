'use client';

import { useState } from 'react';

import { signInSocial, type SocialProvider } from '@/lib/auth-client';
import { Button } from '@/layers/shared/ui';

/** GitHub's brand mark (lucide no longer ships brand glyphs). */
function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" fill="currentColor">
      <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.26.8-.57v-2c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.1-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.1-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.21.69.82.57A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

/** Google's brand "G" mark (lucide has no brand glyph). */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.64h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.56Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.1 0 5.7-1.03 7.6-2.79l-3.72-2.88c-1.03.69-2.35 1.1-3.88 1.1-2.98 0-5.5-2.01-6.4-4.72H1.76v2.97A11.5 11.5 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.6 14.71a6.9 6.9 0 0 1 0-4.42V7.32H1.76a11.5 11.5 0 0 0 0 10.36l3.84-2.97Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.68 0 3.19.58 4.38 1.71l3.28-3.28A11.5 11.5 0 0 0 12 0 11.5 11.5 0 0 0 1.76 6.34l3.84 2.97C6.5 6.6 9.02 4.75 12 4.75Z"
      />
    </svg>
  );
}

/**
 * "Continue with GitHub / Google" buttons wired to the Better Auth social flow.
 * A click starts the OAuth round-trip via {@link signInSocial}; on return the
 * server redirects to `callbackURL`.
 *
 * @param props.callbackURL - Where to land after the OAuth round-trip completes.
 */
export function SocialSignInButtons({ callbackURL }: { callbackURL: string }) {
  const [pending, setPending] = useState<SocialProvider | null>(null);

  async function onClick(provider: SocialProvider) {
    setPending(provider);
    // On success the browser navigates away to the provider; only re-enable if
    // it did not (the request itself failed before redirect).
    await signInSocial({ provider, callbackURL });
    setPending(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={pending !== null}
        onClick={() => onClick('github')}
      >
        <GitHubMark />
        Continue with GitHub
      </Button>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={pending !== null}
        onClick={() => onClick('google')}
      >
        <GoogleMark />
        Continue with Google
      </Button>
    </div>
  );
}
