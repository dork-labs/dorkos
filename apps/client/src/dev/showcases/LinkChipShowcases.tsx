import type { ReactNode } from 'react';
import {
  LinkChipView,
  chatTabIdentity,
  roomTabIdentity,
  type TabIdentity,
} from '@/layers/features/app-tabs';
import { cn, resolveIdentityFace } from '@/layers/shared/lib';
import type { LinkChipRenderProps } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const SCOUT = { emoji: '🔍', color: 'hsl(210 80% 55%)' };
const PIXEL = { emoji: '🎨', color: 'hsl(330 70% 55%)' };

const mayaFace = resolveIdentityFace({
  record: { id: 'maya', kind: 'human', displayName: 'Maya Chen' },
});

/** A stand-in for `MarkdownLink`'s anchor: the real chip, a link that goes nowhere. */
const anchor: LinkChipRenderProps['anchor'] = (content, props) => (
  <a href="#link-chips" onClick={(event) => event.preventDefault()} {...props}>
    {content}
  </a>
);

/** A chat with Scout called "Fix the login bug", in a given state. */
function scoutChat(signals: Parameters<typeof chatTabIdentity>[0]['signals'], detail = {}) {
  return chatTabIdentity({
    agentName: 'Scout',
    visual: SCOUT,
    chatTitle: 'Fix the login bug',
    agentKey: 'scout',
    signals,
    detail,
  });
}

/** Every status a chat chip can wear, hottest first, then idle. */
const STATUSES: { key: string; identity: TabIdentity }[] = [
  {
    key: 'needs-you',
    identity: scoutChat({ needsYou: true }, { needsYou: { kind: 'approval', toolName: 'Bash' } }),
  },
  { key: 'failed', identity: scoutChat({ failed: true }) },
  { key: 'paused', identity: scoutChat({ paused: true }, { resetsAt: '3:40 PM' }) },
  { key: 'working', identity: scoutChat({ working: true }, { activity: 'running tests' }) },
  { key: 'new', identity: scoutChat({ unseen: true }) },
  { key: 'idle', identity: scoutChat({}) },
];

const CHANNEL = roomTabIdentity({ kind: 'channel', title: '#launch', unreadCount: 3 });
const DM = roomTabIdentity({ kind: 'dm', title: 'Maya Chen', face: mayaFace });
const LONG = chatTabIdentity({
  agentName: 'Pixel',
  visual: PIXEL,
  chatTitle: 'Redo the logo, the favicon and every marketing image for the launch page',
  agentKey: 'pixel',
  signals: { working: true },
});

/** A line of reply text, the size and colour chat prose renders at. */
function Line({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed">{children}</p>;
}

/** The chips as they appear inside a reply. */
function Reply() {
  return (
    <div className="flex flex-col gap-2">
      <Line>
        I started{' '}
        <LinkChipView
          kind="chat"
          identity={STATUSES[3]!.identity}
          state="ready"
          label="the fix"
          anchor={anchor}
        />{' '}
        to work on the login bug. Pixel is in{' '}
        <LinkChipView kind="chat" identity={LONG} state="ready" label="the logo" anchor={anchor} />.
      </Line>
      <Line>
        I posted the plan in{' '}
        <LinkChipView kind="room" identity={CHANNEL} state="ready" label="launch" anchor={anchor} />{' '}
        and asked{' '}
        <LinkChipView kind="room" identity={DM} state="ready" label="Maya" anchor={anchor} /> to
        check it.
      </Line>
      <Line>
        The old thread is{' '}
        <LinkChipView
          kind="chat"
          identity={scoutChat({})}
          state="missing"
          label="here"
          anchor={anchor}
        />
        , and{' '}
        <LinkChipView
          kind="chat"
          identity={chatTabIdentity({})}
          state="resolving"
          label="this one"
          anchor={anchor}
        />{' '}
        is still loading.
      </Line>
    </div>
  );
}

/** Link chip showcases: chat, channel and DM links in a reply, every status, both themes. */
export function LinkChipShowcases() {
  return (
    <PlaygroundSection
      title="Link chips"
      description="A link to a chat, channel or DM in a reply draws as a chip: the icon, the name and a live status dot, from the same identity as its tab. Hover a chip with a status for its sentence. One click opens it in place; cmd/ctrl-click opens a new tab."
    >
      <ShowcaseLabel>In a reply</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Reply />
      </ShowcaseDemo>

      <ShowcaseLabel>Every status, hottest first, then idle</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex flex-wrap items-center gap-2">
          {STATUSES.map(({ key, identity }) => (
            <LinkChipView
              key={key}
              kind="chat"
              identity={identity}
              state="ready"
              label={key}
              anchor={anchor}
            />
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Both themes</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col gap-3">
          {(['light', 'dark'] as const).map((theme) => (
            <div key={theme} className={cn(theme, 'bg-background text-foreground rounded-lg p-3')}>
              <p className="text-muted-foreground text-2xs mb-1">{theme}</p>
              <Reply />
            </div>
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
