import { useState } from 'react';
import { Workflow } from 'lucide-react';
import {
  AppTabItemView,
  TabIdentityCard,
  activityBadge,
  connectionsBadge,
  schedulesBadge,
  channelsTabIdentity,
  chatTabIdentity,
  extensionTabIdentity,
  homeTabIdentity,
  marketplaceTabIdentity,
  profileTabIdentity,
  roomTabIdentity,
  routeTabIdentity,
  settingsTabIdentity,
  teamTabIdentity,
  windowTitle,
  type TabIdentity,
} from '@/layers/features/app-tabs';
import { cn, resolveIdentityFace } from '@/layers/shared/lib';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

/** Ten minutes ago, for "Last active" lines that read the same on every load. */
const RECENTLY = Date.now() - 10 * 60 * 1000;

const SCOUT = { emoji: '🔍', color: 'hsl(210 80% 55%)' };
const PIXEL = { emoji: '🎨', color: 'hsl(330 70% 55%)' };

const scoutFace = resolveIdentityFace({
  record: { id: 'scout', kind: 'agent', displayName: 'Scout', emoji: '🔍' },
});
const mayaFace = resolveIdentityFace({
  record: { id: 'maya', kind: 'human', displayName: 'Maya Chen' },
});

/** One tab per route the strip can name, idle. */
const EVERY_ROUTE: { key: string; identity: TabIdentity }[] = [
  {
    key: 'chat',
    identity: chatTabIdentity({
      agentName: 'Scout',
      visual: SCOUT,
      chatTitle: 'Fix the login bug',
      agentKey: 'scout',
      lastActiveAt: RECENTLY,
    }),
  },
  { key: 'channel', identity: roomTabIdentity({ kind: 'channel', title: '#general' }) },
  { key: 'dm', identity: roomTabIdentity({ kind: 'dm', title: 'Maya Chen', face: mayaFace }) },
  { key: 'channels', identity: channelsTabIdentity(0) },
  { key: 'home', identity: homeTabIdentity(0) },
  { key: 'team', identity: teamTabIdentity('/team', { workingCount: 0, signals: {} }) },
  {
    key: 'profile',
    identity: profileTabIdentity({ name: 'Scout', face: scoutFace }),
  },
  { key: 'settings', identity: settingsTabIdentity('Appearance') },
  { key: 'tasks', identity: routeTabIdentity('/tasks') },
  { key: 'activity', identity: routeTabIdentity('/activity') },
  { key: 'connections', identity: routeTabIdentity('/connections') },
  {
    key: 'marketplace',
    identity: marketplaceTabIdentity({ pathname: '/marketplace', query: 'notes' }),
  },
  { key: 'sources', identity: marketplaceTabIdentity({ pathname: '/marketplace/sources' }) },
  { key: 'workspaces', identity: routeTabIdentity('/workspaces') },
  { key: 'reports', identity: routeTabIdentity('/feedback-requests') },
  { key: 'extension', identity: extensionTabIdentity({ title: 'Flow', icon: Workflow }) },
];

/** One tab per status and count, hottest first. */
const EVERY_STATUS: { key: string; identity: TabIdentity }[] = [
  {
    key: 'needs-you',
    identity: chatTabIdentity({
      agentName: 'Scout',
      visual: SCOUT,
      chatTitle: 'Ship the release',
      signals: { needsYou: true },
      detail: { needsYou: { kind: 'approval', toolName: 'Bash' } },
      lastActiveAt: RECENTLY,
    }),
  },
  {
    key: 'failed',
    identity: chatTabIdentity({
      agentName: 'Pixel',
      visual: PIXEL,
      chatTitle: 'Redo the logo',
      signals: { failed: true },
      lastActiveAt: RECENTLY,
    }),
  },
  {
    key: 'paused',
    identity: chatTabIdentity({
      agentName: 'Atlas',
      visual: { emoji: '🧭' },
      chatTitle: 'Plan the launch',
      signals: { paused: true },
      detail: { resetsAt: '3:40 PM' },
      lastActiveAt: RECENTLY,
    }),
  },
  {
    key: 'working',
    identity: chatTabIdentity({
      agentName: 'Scout',
      visual: SCOUT,
      chatTitle: 'Fix the login bug',
      signals: { working: true },
      detail: { activity: 'running tests' },
      lastActiveAt: RECENTLY,
    }),
  },
  {
    key: 'new',
    identity: chatTabIdentity({
      agentName: 'Pixel',
      visual: PIXEL,
      chatTitle: 'Draft the email',
      signals: { unseen: true },
      lastActiveAt: RECENTLY,
    }),
  },
  { key: 'home', identity: homeTabIdentity(3) },
  {
    key: 'team',
    identity: teamTabIdentity('/team', { workingCount: 2, signals: { working: true } }),
  },
  {
    key: 'mention',
    identity: roomTabIdentity({
      kind: 'channel',
      title: '#launch',
      unreadCount: 12,
      mentionCount: 1,
    }),
  },
  {
    key: 'unread',
    identity: roomTabIdentity({ kind: 'channel', title: '#general', unreadCount: 4 }),
  },
  {
    key: 'dm',
    identity: roomTabIdentity({ kind: 'dm', title: 'Maya Chen', unreadCount: 2, face: mayaFace }),
  },
  { key: 'channels', identity: channelsTabIdentity(3) },
];

/** Pages that report their own status: Schedules, Activity, Connections, an add-on. */
const PAGE_BADGES: { key: string; identity: TabIdentity }[] = [
  {
    key: 'tasks-waiting',
    identity: routeTabIdentity('/tasks', schedulesBadge({ waiting: 2, failed: 1, running: [] })),
  },
  {
    key: 'tasks-failed',
    identity: routeTabIdentity('/tasks', schedulesBadge({ waiting: 0, failed: 1, running: [] })),
  },
  {
    key: 'tasks-running',
    identity: routeTabIdentity(
      '/tasks',
      schedulesBadge({ waiting: 0, failed: 0, running: ['Morning digest'] })
    ),
  },
  { key: 'activity', identity: routeTabIdentity('/activity', activityBadge(7)) },
  { key: 'connections', identity: routeTabIdentity('/connections', connectionsBadge(1)) },
  {
    key: 'extension',
    identity: extensionTabIdentity(
      { title: 'Flow', icon: Workflow },
      { status: 'needs-you', count: 2, sentence: '2 ideas wait for you' }
    ),
  },
];

/** Two chats with Scout and one with Pixel: Scout's collapse to the emoji. */
const SHARED_AGENT: { key: string; identity: TabIdentity; collapse: boolean }[] = [
  {
    key: 'a',
    collapse: true,
    identity: chatTabIdentity({
      agentName: 'Scout',
      visual: SCOUT,
      chatTitle: 'Fix the login bug',
      agentKey: 'scout',
    }),
  },
  {
    key: 'b',
    collapse: true,
    identity: chatTabIdentity({
      agentName: 'Scout',
      visual: SCOUT,
      chatTitle: 'Write the release notes',
      agentKey: 'scout',
      signals: { working: true },
    }),
  },
  {
    key: 'c',
    collapse: false,
    identity: chatTabIdentity({
      agentName: 'Pixel',
      visual: PIXEL,
      chatTitle: 'Redo the logo',
      agentKey: 'pixel',
    }),
  },
];

/** A static strip of real tabs: the same component the window draws. */
function Strip({
  tabs,
  label,
}: {
  tabs: { key: string; identity: TabIdentity; collapse?: boolean }[];
  label: string;
}) {
  const [activeKey, setActiveKey] = useState(tabs[0]?.key);
  return (
    <div className="bg-muted/40 overflow-hidden rounded-lg border">
      <div className="flex min-w-0 overflow-x-auto px-2 py-1">
        <div role="tablist" aria-label={label} className="flex items-stretch gap-1">
          {tabs.map(({ key, identity, collapse }) => (
            <AppTabItemView
              key={key}
              identity={identity}
              isActive={key === activeKey}
              canClose
              collapseAgent={collapse}
              tabProps={{
                ref: () => {},
                tabIndex: key === activeKey ? 0 : -1,
                onClick: () => setActiveKey(key),
                onKeyDown: () => {},
              }}
              onClose={() => {}}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Tab identity showcases: every route, every status, smart names, the hover card and the title. */
export function TabIdentityShowcases() {
  return (
    <PlaygroundSection
      title="Tab identity"
      description="Every tab says who or where, and whether it needs you. The strip, the hover card, the History menu and the window title all read one identity, so they never disagree. One mark at most: a count, or a dot. Hover a tab for its card."
    >
      <ShowcaseLabel>Every route (idle)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Strip tabs={EVERY_ROUTE} label="Every route" />
      </ShowcaseDemo>

      <ShowcaseLabel>Every status and count, hottest first</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Strip tabs={EVERY_STATUS} label="Every status" />
      </ShowcaseDemo>

      <ShowcaseLabel>Pages that report their own status</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex flex-col gap-3">
          <Strip tabs={PAGE_BADGES} label="Page badges" />
          <div className="flex flex-wrap gap-3">
            {PAGE_BADGES.map(({ key, identity }) => (
              <div
                key={key}
                className="bg-popover text-popover-foreground w-64 rounded-md border p-3 shadow-md"
              >
                <TabIdentityCard identity={identity} />
              </div>
            ))}
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Both themes</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col gap-3">
          {(['light', 'dark'] as const).map((theme) => (
            <div key={theme} className={cn(theme, 'bg-background text-foreground rounded-lg p-2')}>
              <p className="text-muted-foreground text-2xs mb-1">{theme}</p>
              <Strip tabs={EVERY_STATUS.slice(0, 7)} label={`Statuses, ${theme}`} />
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Two chats with one agent: the chat title leads</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Strip tabs={SHARED_AGENT} label="Smart names" />
      </ShowcaseDemo>

      <ShowcaseLabel>The hover card</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-3">
          {EVERY_STATUS.slice(0, 5).map(({ key, identity }) => (
            <div
              key={key}
              className="bg-popover text-popover-foreground w-64 rounded-md border p-3 shadow-md"
            >
              <TabIdentityCard identity={identity} />
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>The window title, from the same identity</ShowcaseLabel>
      <ShowcaseDemo>
        <ul className="space-y-1 font-mono text-xs">
          {[
            windowTitle(EVERY_ROUTE[0]!.identity, {
              hidden: false,
              unseenReply: false,
              badgeCount: 0,
            }),
            windowTitle(EVERY_STATUS[0]!.identity, {
              hidden: false,
              unseenReply: false,
              badgeCount: 0,
            }),
            windowTitle(EVERY_ROUTE[0]!.identity, {
              hidden: true,
              unseenReply: true,
              badgeCount: 2,
            }),
            windowTitle(EVERY_ROUTE[5]!.identity, {
              hidden: false,
              unseenReply: false,
              badgeCount: 0,
            }),
            windowTitle(EVERY_ROUTE[7]!.identity, {
              hidden: false,
              unseenReply: false,
              badgeCount: 0,
            }),
          ].map((title) => (
            <li key={title}>{title}</li>
          ))}
        </ul>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
