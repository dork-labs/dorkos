import { CloudEligibilityNote, CloudLinkPanel } from '@/layers/features/cloud-link';
import { CloudPlanPanel, readCreditsFor, useCloudCredits } from '@/layers/features/cloud-plan';

/**
 * Settings › DorkOS account — the hosted account's one home in the app
 * (DOR-2628), fixed directly after Profile.
 *
 * Signed out it is a calm page: what an account would add HERE, then one
 * button. Signed in it is the account itself — Plan, Credits, Use credits for,
 * What's on your account, Seats — with "Unlink this computer" last. The link
 * flow's own states (the code, an expired code, a refusal) render in place, so
 * nothing about the account ever sends somebody to a second surface.
 *
 * No badge and no dot anywhere on it: an install without an account is a
 * complete install, and this tab never suggests otherwise.
 */
export function DorkosAccountTab() {
  return (
    <CloudLinkPanel signedOut={<SignedOutPage />}>
      <CloudPlanPanel />
    </CloudLinkPanel>
  );
}

/**
 * What a DorkOS account would add on this computer, before it is linked.
 *
 * **Only what the server reports as wired.** Nothing is promised that this
 * server cannot do today: the credits line appears only while the server has
 * credits switched on, naming exactly the runtimes it reaches, and with nothing
 * wired the page says one plain line instead of a list of hopes.
 */
function SignedOutPage() {
  const { data: credits } = useCloudCredits();
  const runtimes = readCreditsFor(credits).map((row) => row.name);

  return (
    <div className="space-y-2">
      {runtimes.length > 0 ? (
        <>
          <p className="text-sm">Link this computer to a DorkOS account to:</p>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            <li>
              Use one account for {runtimes.join(' and ')}: run{' '}
              {runtimes.length === 1 ? 'it' : 'them'} on your DorkOS credits.
            </li>
            <li>See your plan, your credits and your seats here.</li>
          </ul>
        </>
      ) : (
        <p className="text-muted-foreground text-sm">
          Link this computer to a DorkOS account to see your plan, your credits and your seats here.
          Everything else works without one.
        </p>
      )}
      {/* Said before anybody links in order to buy, not after. */}
      <CloudEligibilityNote />
    </div>
  );
}
