/**
 * Block Buddies at list size (DOR-3065): how far apart 24 made-up agents look, and
 * what the state rings do on the surfaces a face actually sits on.
 *
 * At a wide window every tile is the 18px mini crop. Below `md` the same tile is
 * the 24px full rig, the sidebar's own slot, so one sheet shows both sizes.
 *
 * @module dev/showcases/BlockBuddyShowcases
 */
import { useEffect } from 'react';
import { IdentityAvatar, SIDEBAR_FACE, type IdentityStatus } from '@/layers/shared/ui';
import { setBlockBuddiesEnabled } from '@/layers/shared/lib';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** The ULID alphabet, so these read as real agent ids to `resolveAgentVisual`. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A made-up id: stable across reloads, so two shots of the sheet compare. */
function madeUpId(index: number): string {
  // `Math.imul` stays in 32 bits. A plain `*` here overflows into float rounding,
  // and the ids it makes come out mostly the same.
  let state = Math.imul(index + 1, 2654435761);
  let id = '01M';
  while (id.length < 26) {
    state = Math.imul(state ^ (state >>> 15), 1540483477) + 12345;
    id += ALPHABET[(state >>> 20) % ALPHABET.length];
  }
  return id;
}

const IDS = Array.from({ length: 24 }, (_, index) => madeUpId(index));

const STATES: readonly IdentityStatus[] = ['idle', 'working', 'needs-you', 'error'];

const SURFACES = [
  { label: 'Page', className: 'bg-background' },
  { label: 'Sidebar', className: 'bg-sidebar' },
  { label: 'Selected row', className: 'bg-sidebar-accent' },
] as const;

function Buddy({ seed, status = 'idle' }: { seed: string; status?: IdentityStatus }) {
  return (
    <IdentityAvatar
      kind="agent"
      size="xs"
      color="#888888"
      buddySeed={seed}
      buddyPhoneSize={24}
      status={status}
      data-seed={seed}
      className={SIDEBAR_FACE}
    />
  );
}

/** The spread of faces at list size, and each state on each surface. */
export function BlockBuddyShowcases() {
  // The dev playground sits outside the app shell, so nothing syncs the flag here.
  useEffect(() => {
    setBlockBuddiesEnabled(true);
    return () => setBlockBuddiesEnabled(false);
  }, []);

  return (
    <PlaygroundSection
      title="Block Buddies"
      description="Agent faces behind the Block Buddies experiment, on made-up ids. 18px mini crop on a wide window, 24px full rig on a phone."
    >
      <ShowcaseLabel>Spread: 24 made-up agents</ShowcaseLabel>
      <ShowcaseDemo>
        <div data-testid="buddy-spread" className="grid grid-cols-6 gap-3 sm:grid-cols-12">
          {IDS.map((seed) => (
            <Buddy key={seed} seed={seed} />
          ))}
        </div>
      </ShowcaseDemo>
      <ShowcaseLabel>State × surface</ShowcaseLabel>
      <ShowcaseDemo>
        <div data-testid="buddy-states" className="flex flex-col gap-2">
          {SURFACES.map((surface) => (
            <div key={surface.label} className={`rounded-md p-3 ${surface.className}`}>
              <p className="text-muted-foreground mb-2 text-xs">{surface.label}</p>
              {STATES.map((status) => (
                // A phone holds the label and four tiles. Past that the row runs off the screen.
                <div
                  key={status}
                  className="mb-2 flex items-center gap-3 max-md:[&>*:nth-child(n+6)]:hidden"
                >
                  <span className="text-muted-foreground w-20 shrink-0 text-xs whitespace-nowrap">
                    {status}
                  </span>
                  {IDS.slice(0, 8).map((seed) => (
                    <Buddy key={seed} seed={seed} status={status} />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
