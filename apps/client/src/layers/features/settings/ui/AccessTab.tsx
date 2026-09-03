import { SecurityPanel } from '@/layers/features/auth';
import { CloudLinkPanel } from '@/layers/features/cloud-link';
import { useDeepLinkScroll, useSettingsDeepLink } from '@/layers/shared/model';

/**
 * Access tab for the Settings dialog — who may get into this install, and as
 * whom.
 *
 * One tab, two sections. It used to be two tabs whose bodies were a 12-line and
 * a 14-line wrapper each, answering the same question from two sidebar rows in a
 * sidebar already carrying thirteen (DOR-1758). Both halves are still their own
 * feature slice — `features/auth` owns local login and API keys, `features/cloud-link`
 * owns the account link — and this only slots them into one surface (sibling UI
 * composition).
 *
 * `?settings=security` and `?settings=account` are the addresses people already
 * have; the legacy map in `use-dialog-deep-link.ts` sends each to this tab with
 * its own section anchor, and the scroll hook below is what makes the anchor
 * land on the right half instead of the top of the page.
 */
export function AccessTab() {
  const { section } = useSettingsDeepLink();
  useDeepLinkScroll(section);

  return (
    <div className="space-y-8">
      <section data-section="security" className="space-y-3">
        {/* Muted/uppercase/tracking, not the panel title's own size and
            weight — one heading reads as the panel, this one as subordinate
            to it, the way the sidebar's own group labels already do. */}
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          On this machine
        </h3>
        <SecurityPanel />
      </section>

      <section data-section="account" className="space-y-3">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          DorkOS account
        </h3>
        <CloudLinkPanel />
      </section>
    </div>
  );
}
