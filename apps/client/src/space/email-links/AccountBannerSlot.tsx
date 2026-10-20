import { useEffect, useState, type ComponentType } from 'react';
import type { CommunityWireAccountSignInMethods } from '@dorkos/shared/community-wire';
import { hostRequest } from '../api.js';
import { useSignInOptions } from '../sign-in-options.js';

/** What an account banner may look at to decide whether it applies. */
export interface AccountBannerContext {
  /** The signed-in account's id, for per-account "Not now" storage. */
  accountId: string;
  /** Whether this space mails links at all. */
  emailLinks: boolean;
  /** How the account signs in, and whether its email was ever confirmed. */
  methods: CommunityWireAccountSignInMethods;
}

/** One account-level banner: whether it applies now, and what it shows. */
export interface AccountBanner {
  id: string;
  applies: (context: AccountBannerContext, now: number) => boolean;
  Banner: ComponentType<{ context: AccountBannerContext; onDone: () => void }>;
}

/**
 * The one place account-level banners show, under the community's own banners. It takes an
 * ordered list and shows only the first that applies, so a person is never asked two account
 * things at once; a banner that is done (sent, hidden) gives way to none until the next load.
 */
export function AccountBannerSlot({ banners }: { banners: readonly AccountBanner[] }) {
  const options = useSignInOptions();
  const [context, setContext] = useState<Omit<AccountBannerContext, 'emailLinks'> | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([
      hostRequest<{ user?: { id: string } } | null>('/api/auth/get-session'),
      hostRequest<CommunityWireAccountSignInMethods>('/api/v1/account/sign-in-methods'),
    ])
      .then(([session, methods]) => {
        if (active && session?.user) setContext({ accountId: session.user.id, methods });
      })
      // A banner is a courtesy: without its reads, none shows.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  if (!context || dismissed) return null;
  const full = { ...context, emailLinks: options.emailLinks };
  const now = Date.now();
  const first = banners.find((banner) => banner.applies(full, now));
  if (!first) return null;
  const { Banner } = first;
  return <Banner context={full} onDone={() => setDismissed(true)} />;
}
