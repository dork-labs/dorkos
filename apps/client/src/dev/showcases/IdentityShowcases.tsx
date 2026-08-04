import type * as React from 'react';
import { MentionPill, IdentityHoverCard } from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_IDENTITIES, type MockIdentity } from '../mock-samples';

/**
 * A mention pill on its own, as it would sit anywhere else — never inside a
 * flowing sentence, so the wrap showcase below is the only place that draws
 * one in running text.
 */
function Pill({
  identity,
  ...rest
}: { identity: MockIdentity } & Partial<
  Omit<React.ComponentProps<typeof MentionPill>, 'kind' | 'label' | 'color' | 'origin' | 'handle'>
>) {
  return (
    <MentionPill
      kind={identity.kind}
      label={identity.displayName}
      handle={identity.handle}
      color={identity.color}
      origin={identity.origin}
      resolved
      {...rest}
    />
  );
}

/**
 * A hover-card trigger, styled like the pill or avatar it would wrap in the
 * real feed — the card itself only draws once the pointer sits on this.
 */
function Trigger({ identity }: { identity: MockIdentity }) {
  return (
    <IdentityHoverCard identity={identity}>
      <button
        type="button"
        className="hover:bg-accent focus-visible:ring-ring rounded-md border px-2.5 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
      >
        {identity.displayName}
      </button>
    </IdentityHoverCard>
  );
}

/** MentionPill and IdentityHoverCard showcases — the two new identity surfaces (spec `composer-identity-components`). */
export function IdentityShowcases() {
  return (
    <>
      <PlaygroundSection
        title="MentionPill"
        description="A resolved @mention, styled by who it points at: an agent wears its own colour with a Bot glyph in place of the @; a person is a neutral @name pill; unresolved text carries no pill and no pointer at all."
      >
        <ShowcaseLabel>Agent, human, external, system</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-2">
            <Pill identity={MOCK_IDENTITIES.warden} />
            <Pill identity={MOCK_IDENTITIES.scout} />
            <Pill identity={MOCK_IDENTITIES.ana} />
            <Pill identity={MOCK_IDENTITIES.priya} />
            <Pill identity={MOCK_IDENTITIES.roomNotice} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Unresolved — plain text, no pill, no pointer</ShowcaseLabel>
        <ShowcaseDemo>
          <p className="text-sm">
            can you loop in{' '}
            <MentionPill kind="human" label="someone-not-in-room" resolved={false} /> on this?
          </p>
        </ShowcaseDemo>

        <ShowcaseLabel>Interactive — hover/cursor affordance, click still deferred</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-2">
            <Pill identity={MOCK_IDENTITIES.warden} interactive />
            <Pill identity={MOCK_IDENTITIES.ana} interactive />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Long handle in running text — wraps within the line, never truncates
        </ShowcaseLabel>
        <ShowcaseDemo>
          <p className="max-w-xs text-sm">
            can you rebase this onto <Pill identity={MOCK_IDENTITIES.longHandle} /> before the
            freeze?
          </p>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="IdentityHoverCard"
        description="The compact card that opens over an identity: name, @handle subtitle, a couple of fact chips, and a footer pinned under everything for a profile view that doesn't exist yet."
      >
        <ShowcaseLabel>Agent — working, and idle</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            <Trigger identity={MOCK_IDENTITIES.warden} />
            <Trigger identity={MOCK_IDENTITIES.scout} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Person — local, and bridged from an external platform</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            <Trigger identity={MOCK_IDENTITIES.ana} />
            <Trigger identity={MOCK_IDENTITIES.priya} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>System — the room&apos;s own voice, no chips, no handle</ShowcaseLabel>
        <ShowcaseDemo>
          <Trigger identity={MOCK_IDENTITIES.roomNotice} />
        </ShowcaseDemo>

        <ShowcaseLabel>Edge cases — long name/handle, light fill, ZWJ emoji</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            <Trigger identity={MOCK_IDENTITIES.longHandle} />
            <Trigger identity={MOCK_IDENTITIES.noEmojiFill} />
            <Trigger identity={MOCK_IDENTITIES.multiCodepointEmoji} />
            <Trigger identity={MOCK_IDENTITIES.externalFlag} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
