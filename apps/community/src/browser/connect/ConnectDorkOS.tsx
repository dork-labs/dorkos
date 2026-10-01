import { Notice } from '@dork-labs/ui';
import { CopyableLink } from './CopyableLink.js';

/**
 * How to bring this community into the DorkOS app, in the app's own words, with the community's
 * link to paste. The steps follow the app's context switcher, which is at the top left on every
 * screen (the sidebar's header on a computer, an icon at the start of the top bar on a phone) and
 * shows whichever name is selected, so the steps name its place, not its label: Add a space,
 * then Join a space…, which asks for this link (a host's bare address is refused when it holds more than
 * one community). The app calls a community a "space" (DOR-2631), so the steps use its words.
 */
export function ConnectDorkOS({ link }: { link: string }) {
  return (
    <Notice tone="info" className="mt-4 text-left">
      <strong>Connect DorkOS to this community</strong>
      <ol className="small mt-2 mb-3 list-decimal space-y-1 pl-5">
        <li>In the DorkOS app, open the menu at the top left.</li>
        <li>
          Choose <strong>Add a space</strong>, then <strong>Join a space…</strong>
        </li>
        <li>Paste this community’s link, then approve it here when asked.</li>
      </ol>
      <CopyableLink label="This community’s link" link={link} />
      <p className="small muted mt-2 mb-0">Each DorkOS installation needs its own approval.</p>
    </Notice>
  );
}
