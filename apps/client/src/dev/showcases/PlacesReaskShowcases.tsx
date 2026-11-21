/**
 * The Inbox card for apps that ask again only because they now say where
 * they show (DOR-4282), drawn with the real `ExtensionApprovalList` and
 * made-up apps: 22 places-only rows in one card, collapsed and expanded, and
 * one app that also adds a power, which keeps its own card.
 *
 * @module dev/showcases/PlacesReaskShowcases
 */
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { ExtensionApprovalList, PlacesReaskCard } from '@/layers/widgets/inbox-bell';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Made-up app names, one per row. */
const NAMES = [
  'Atlas',
  'Beacon',
  'Cinder',
  'Drift',
  'Ember',
  'Fable Notes',
  'Grove',
  'Harbor',
  'Iris',
  'Juniper',
  'Kestrel',
  'Lumen',
  'Meadow',
  'Nimbus',
  'Orchid',
  'Pebble',
  'Quill',
  'Ridge',
  'Sable',
  'Tidal',
  'Umber',
  'Vale',
];

/** The places each made-up app now declares, in rotation. */
const PLACES: string[][] = [
  ['pages'],
  ['pages', 'status-bar'],
  ['pages', 'inbox'],
  ['command-palette.items'],
  ['pages', 'dialog'],
];

/** A made-up app that keeps running while the places it now declares wait. */
function placesOnly(name: string, index: number): PendingExtensionApproval {
  const id = `sample-${name.toLowerCase().replace(/\s+/g, '-')}`;
  return {
    id,
    name,
    version: '1.1.0',
    path: `/home/sample/.dork/plugins/${id}/extensions/${id}`,
    plugin: id,
    sourceLabel: 'from dork-labs/marketplace',
    runsInServer: false,
    adds: null,
    since: '2026-11-19T12:00:00.000Z',
    why: `You installed ${name} from dork-labs/marketplace.`,
    permissions: {
      runtime: 'in-process',
      net: [],
      run: [],
      agents: false,
      hasPage: true,
      slots: PLACES[index % PLACES.length],
    },
    added: {
      net: [],
      run: [],
      agents: false,
      runtime: false,
      slots: PLACES[index % PLACES.length],
    },
    agentTools: [],
    agentSkills: [],
    digest: null,
    changedFiles: null,
    updatedFrom: null,
    placesOnly: true,
  };
}

/** Twenty-two places-only re-asks. */
const PLACES_ONLY = NAMES.map(placesOnly);

/** One that also wants a new host, so it keeps its full card. */
const WITH_POWER: PendingExtensionApproval = {
  ...placesOnly('Weather', 0),
  runsInServer: true,
  why: 'Weather was updated from 1.0.0 to 1.1.0: extension.json. It runs as you.',
  permissions: {
    runtime: 'subprocess',
    net: ['api.weather.example.com'],
    run: [],
    agents: false,
    hasPage: true,
    slots: ['pages'],
  },
  added: {
    net: ['api.weather.example.com'],
    run: [],
    agents: false,
    runtime: false,
    slots: ['pages'],
  },
  changedFiles: ['extension.json'],
  updatedFrom: '1.0.0',
  placesOnly: false,
};

/** The frame every demo sits in: the Inbox panel's width. */
const FRAME = 'border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2';

/** The grouped card, collapsed and expanded, beside a row that adds a power. */
export function PlacesReaskShowcases() {
  return (
    <PlaygroundSection
      title="Places re-ask card"
      description="Apps that keep running while new places wait share one card. Each row answers alone; an app that also wants more keeps its own card."
    >
      <ShowcaseLabel>22 apps in one card, plus one that adds a host</ShowcaseLabel>
      <ShowcaseDemo>
        <div data-testid="places-reask-collapsed" className={FRAME}>
          <ExtensionApprovalList
            approvals={[...PLACES_ONLY, WITH_POWER]}
            onOpenSettings={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Every row shown, two already answered</ShowcaseLabel>
      <ShowcaseDemo>
        <div data-testid="places-reask-expanded" className={FRAME}>
          <PlacesReaskCard
            rows={PLACES_ONLY.map((approval, index) => ({
              approval,
              answer: index === 1 ? 'allowed' : index === 3 ? 'not-now' : null,
            }))}
            pending={null}
            onAllow={() => {}}
            onNotNow={() => {}}
            defaultExpanded
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
