import { useMemo } from 'react';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import { useNow } from '@/layers/shared/model';
import { SidebarProvider, Sidebar, SidebarContent, SidebarMenu } from '@/layers/shared/ui';
import { mergeJumpBackIn, type JumpBackInRoomItem } from '@/layers/entities/recents';
import { JumpBackInRoomRow, JumpBackInSessionRow } from '@/layers/features/dashboard-sidebar';
import type { IdentityMark } from '@/layers/entities/room';
import { JumpBackInPopover } from '@/layers/features/jump-back-in';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * Thin sidebar shell — these rows read their width from the sidebar they sit
 * in, and truncation is most of what there is to look at.
 */
function SidebarShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar variant="inset" className="relative h-auto min-h-0 w-64 shrink-0 border-none">
        <SidebarContent className="p-2">
          <SidebarMenu>{children}</SidebarMenu>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
}

/**
 * Build the fixture from the shared clock, not from module-scope `Date.now()`.
 *
 * Every row shows a relative time, so a fixture frozen when the module was
 * imported drifts further from "now" the longer the playground tab stays open —
 * "2m ago" quietly becomes "3h ago" without anything having happened. `useNow`
 * is the cockpit's own ticking clock, so the fixture re-bases on the same
 * minute boundary the rows re-render on, and nothing impure runs during render.
 */
function useJumpBackInFixture() {
  const now = useNow(60_000);

  return useMemo(() => {
    const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString();

    const session = (overrides: Partial<Session> & Pick<Session, 'id' | 'title'>): Session => ({
      createdAt: minutesAgo(240),
      updatedAt: minutesAgo(45),
      permissionMode: 'default',
      runtime: 'claude-code',
      ...overrides,
    });

    const room = (
      overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id' | 'kind'>
    ): RoomSummary => ({
      slug: null,
      title: 'Untitled',
      topic: null,
      workspaceId: null,
      archived: false,
      createdAt: minutesAgo(1440),
      lastActivityAt: minutesAgo(30),
      unreadCount: 0,
      participants: null,
      ...overrides,
    });

    return mergeJumpBackIn({
      sessions: [
        session({
          id: 'sess-1',
          title: 'Refactor auth middleware',
          lastMessagePreview: 'Middleware is green — moving on to the tests',
          updatedAt: minutesAgo(12),
        }),
        session({
          id: 'sess-2',
          title: 'Fix CORS headers for relay',
          updatedAt: minutesAgo(50),
        }),
      ],
      rooms: [
        room({
          id: 'c1',
          kind: 'channel',
          slug: 'general',
          title: 'general',
          unreadCount: 4,
          lastActivityAt: minutesAgo(2),
        }),
        room({
          id: 'c2',
          kind: 'channel',
          slug: 'releases',
          title: 'releases',
          topic: 'Ship notes and rollbacks',
          lastActivityAt: minutesAgo(20),
        }),
        room({
          id: 'd1',
          kind: 'dm',
          title: 'code-reviewer',
          working: 1,
          lastActivityAt: minutesAgo(8),
        }),
      ],
    });
  }, [now]);
}

/**
 * The composer's half of the same list: the panel that floats over the home
 * composer the moment somebody focuses it while it is still empty.
 *
 * Presentational, so it draws here with no fleet, no queries and no composer —
 * which is also why the keyboard does nothing in this demo. What to draw and
 * which row is lit are props; the hook that supplies them lives with the real
 * composer.
 */
function JumpBackInPopoverShowcase() {
  const { items } = useJumpBackInFixture();

  // What the host derives from the real fleet (`roomIdentityMark`), stood in for
  // here: a channel wears its own `#`, a direct message wears its agent's face.
  const visualOf = (room: RoomSummary): IdentityMark =>
    room.kind === 'dm'
      ? { kind: 'identity', visual: { color: '#6366f1', emoji: '🔍' } }
      : { kind: 'sigil' };

  return (
    <PlaygroundSection
      title="Jump back in popover"
      description="The second surface of one recents model. Focusing the empty home composer floats this over it: the last few threads across every kind, capped at six because it is a glance rather than a list. Focus never leaves the composer — the rows are listbox options the text field announces through aria-activedescendant, so the arrows move the highlight while the caret stays where it was."
    >
      <ShowcaseLabel>Highlighted row is the one Enter opens</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-xl">
          <JumpBackInPopover
            rows={items.slice(0, 4)}
            selectedIndex={2}
            visualOf={visualOf}
            onSelect={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>One thread to come back to</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-xl">
          <JumpBackInPopover
            rows={items.slice(0, 1)}
            selectedIndex={0}
            visualOf={visualOf}
            onSelect={() => {}}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The sidebar's recency shortcut, one row per kind of thread. */
export function JumpBackInShowcases() {
  const { items } = useJumpBackInFixture();
  const firstChannel = items.find((item) => item.kind === 'channel') as
    | JumpBackInRoomItem
    | undefined;

  return (
    <>
      <PlaygroundSection
        title="Jump back in rows"
        description="The sidebar's recency shortcut mixes three kinds of thread in one list: sessions, direct messages and channels. Every row is a mark, a name, a relative time, and — only when there is something honest to say — one line about what last happened (unread count, agents working, or the channel topic). A row with nothing to say draws one line, not an empty second one."
      >
        <ShowcaseLabel>
          All three kinds, most recent first (second row is the one on screen)
        </ShowcaseLabel>
        <ShowcaseDemo>
          <SidebarShell>
            {items.map((item, index) =>
              item.kind === 'session' ? (
                <JumpBackInSessionRow
                  key={item.id}
                  item={item}
                  agent={null}
                  displayName="code-reviewer"
                  isActive={index === 1}
                  onClick={() => {}}
                />
              ) : (
                <JumpBackInRoomRow
                  key={item.id}
                  item={item}
                  visual={
                    item.room.kind === 'dm'
                      ? { kind: 'identity', visual: { color: '#6366f1', emoji: '🔍' } }
                      : { kind: 'sigil' }
                  }
                  isActive={index === 1}
                  onClick={() => {}}
                />
              )
            )}
          </SidebarShell>
        </ShowcaseDemo>

        <ShowcaseLabel>Long names and long summaries truncate to one line each</ShowcaseLabel>
        <ShowcaseDemo>
          <SidebarShell>
            {firstChannel && (
              <JumpBackInRoomRow
                item={{
                  ...firstChannel,
                  summary:
                    'A summary long enough that it has to be cut off rather than wrapping onto a third line',
                }}
                visual={{ kind: 'sigil' }}
                onClick={() => {}}
              />
            )}
          </SidebarShell>
        </ShowcaseDemo>
      </PlaygroundSection>

      <JumpBackInPopoverShowcase />
    </>
  );
}
