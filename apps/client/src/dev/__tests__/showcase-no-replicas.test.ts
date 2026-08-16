/**
 * The playground must SHOW the product, not a drawing of it.
 *
 * A showcase that hand-copies a component's markup looks right on the day it is
 * written and is wrong from the first time the real component moves — silently,
 * because nothing renders both. It happened here: when the health vocabulary
 * moved to one map (DOR-1052), `TopologyShowcases` kept drawing the retired
 * design — a pinging green swatch, raw `bg-green-500` / `bg-amber-500`, and no
 * entry at all for the status that means "this agent cannot be reached".
 *
 * A playground showing a design the product no longer has is worse than no
 * playground, because it is believed. These are source-level checks for the same
 * reason `playground-registry.test.ts`'s drift block is: the failure is a
 * component that is NOT rendered, which no render test can see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const DEV_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read one file under `dev/`. */
function showcaseSource(...segments: string[]): string {
  return readFileSync(join(DEV_DIR, ...segments), 'utf8');
}

/**
 * The same source with its comments removed.
 *
 * The checks below look for retired class names, and a comment explaining WHY a
 * class name is retired contains that name — so a scan over raw source fails on
 * its own documentation and the only way to keep it green is to stop explaining
 * things. Code only.
 */
function showcaseCode(...segments: string[]): string {
  return showcaseSource(...segments)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('the topology showcases render the real components', () => {
  const source = showcaseSource('showcases', 'TopologyShowcases.tsx');

  it('renders the actual TopologyLegend rather than a copy of its markup', () => {
    expect(source).toContain('<TopologyLegend');
    expect(source).toMatch(/from '@\/layers\/features\/mesh\/ui\/TopologyLegend'/);
  });

  it('spells no health colour of its own', () => {
    // Every health swatch on this page has to come from `HEALTH_DISPLAY`, which
    // is the map the nodes and the legend both read. A literal here is a fourth
    // source of truth for a fact that already has one.
    const code = showcaseCode('showcases', 'TopologyShowcases.tsx');
    for (const raw of ['bg-green-500', 'bg-amber-500', 'bg-emerald-500']) {
      expect(code, `${raw} is a hand-spelled health colour — use HEALTH_DISPLAY`).not.toContain(
        raw
      );
    }
  });

  it('animates nothing for health, on this page or its node replicas', () => {
    // Health is a state ("seen within the last hour"), not an event. The legend
    // swatch used to ping, which taught the reader that green-and-moving meant
    // health rather than a turn in flight.
    for (const file of ['TopologyShowcases.tsx', 'topology-agent-node.tsx']) {
      expect(showcaseCode('showcases', file), `${file} animates a health mark`).not.toContain(
        'animate-ping'
      );
    }
  });
});

describe('the status showcases render the real components', () => {
  const source = showcaseSource('showcases', 'StatusShowcases.tsx');
  const code = showcaseCode('showcases', 'StatusShowcases.tsx');

  it('renders the actual ErrorMessageBlock rather than a copy of its markup', () => {
    // This is what drifted: ChatPanel renders transport errors through
    // ErrorMessageBlock, but the showcase hand-drew its own
    // `TransportErrorBanner` — self-documented as a replica — with markup that
    // had already diverged from the real component.
    expect(source).toContain('<ErrorMessageBlock');
    expect(source).toMatch(/from '@\/layers\/features\/chat\/ui\/message\/ErrorMessageBlock'/);
  });

  it('defines no local transport-error banner of its own', () => {
    expect(code, 'still defines a local TransportErrorBanner replica').not.toMatch(
      /function TransportErrorBanner/
    );
  });

  it('draws no icon or destructive-card chrome of its own for the transport error', () => {
    // ErrorMessageBlock owns its own AlertTriangle icon and its own
    // border/background pair for the destructive card. A showcase rendering
    // the real component never needs either — importing the icon, or
    // hand-spelling the exact class pair the component already applies
    // internally, is the tell that a local replica crept back in.
    expect(
      code,
      'imports AlertTriangle — ErrorMessageBlock already renders its own icon'
    ).not.toMatch(/AlertTriangle/);
    expect(
      code,
      'hand-spells the destructive banner chrome ErrorMessageBlock already owns'
    ).not.toContain('border-destructive/30 bg-destructive/5');
  });
});

describe('the composer disposition showcase renders the real components', () => {
  // The "Composer dispositions" section (DOR-1198) is where the split action's
  // states get eyes on them: idle Send, busy-with-steer, busy-without-steer, and
  // the downgraded chip. It MUST render the real Composer.Input and the real
  // QueuePanel — a replica would be a second drawing of the exact thing this
  // section exists to prove, and would drift the moment the composer moves.
  const source = showcaseSource('showcases', 'InputShowcases.tsx');

  /** The body of one top-level `function <name>(` in the file, up to the next one. */
  function functionBody(name: string): string {
    const start = source.indexOf(`function ${name}(`);
    expect(start, `${name} is gone from InputShowcases`).toBeGreaterThan(-1);
    const rest = source.slice(start + `function ${name}(`.length);
    const next = rest.indexOf('\nfunction ');
    return next === -1 ? rest : rest.slice(0, next);
  }

  /** Just the "Composer dispositions" PlaygroundSection block. */
  const dispositionSection = (() => {
    const start = source.indexOf('title="Composer dispositions"');
    expect(start, 'the Composer dispositions section is gone').toBeGreaterThan(-1);
    const rest = source.slice(start);
    return rest.slice(0, rest.indexOf('</PlaygroundSection>'));
  })();

  it('imports the real Composer.Input and QueuePanel', () => {
    expect(source).toMatch(/import \{ Composer \} from '@\/layers\/features\/composer'/);
    expect(source).toMatch(
      /import \{ QueuePanel \} from '@\/layers\/features\/chat\/ui\/input\/QueuePanel'/
    );
  });

  it('drives its busy states through the real Composer.Input, not a hand-rolled replica', () => {
    // The section mounts its composer states through ComposerInputDemo, whose one
    // job is to render the REAL Composer.Input with mock state. If that wrapper is
    // ever rebuilt as a replica — a raw <textarea> and fake send buttons — this
    // reds, which is the whole point (DOR-1186).
    expect(dispositionSection).toContain('<ComposerInputDemo');
    const demo = functionBody('ComposerInputDemo');
    expect(demo, 'ComposerInputDemo no longer renders the real Composer.Input').toContain(
      '<Composer.Input'
    );
    expect(demo, 'ComposerInputDemo hand-rolls a <textarea> replica').not.toContain('<textarea');
  });

  it('draws the downgraded chip with the real QueuePanel, not a copy of its rows', () => {
    expect(dispositionSection).toContain('<QueuePanel');
  });
});
