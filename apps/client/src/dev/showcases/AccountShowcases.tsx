import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { AccountMenu, ProfilePanel, handleErrorMessage } from '@/layers/features/profile';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_TEAM_ROSTER, withSuggestedName } from '../mock-samples';
import { createPlaygroundTransport } from '../playground-transport';

const SELF = MOCK_TEAM_ROSTER.find((member) => member.isSelf)!;

/**
 * The same person, with a photo. A tiny inline SVG data URI so the playground
 * needs no network and no fixture file.
 */
const WITH_PHOTO: TeamMember = {
  ...SELF,
  imageUrl:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="%236d5ae0"/><circle cx="32" cy="24" r="12" fill="%23fff"/><path d="M8 64c0-14 11-22 24-22s24 8 24 22z" fill="%23fff"/></svg>'
    ),
};

/** A refusal shaped exactly as the transport throws one. */
function refusal(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/**
 * The three answers a handle save can come back with.
 *
 * Rendered through the product's own {@link handleErrorMessage}, so this list
 * cannot drift into sentences DorkOS no longer says.
 */
const HANDLE_REFUSALS: { code: string; server: string }[] = [
  { code: 'HANDLE_TAKEN', server: "@scout is already somebody else's handle." },
  { code: 'HANDLE_RESERVED', server: '@scout is reserved.' },
  { code: 'INVALID_HANDLE', server: 'A handle is all lowercase.' },
];

/** Everything Settings › Profile needs: a transport for its saves, and a cache. */
function ProfilePanelDemo({ member }: { member: TeamMember }) {
  const transport = useMemo(() => createPlaygroundTransport(), []);
  const queryClient = useMemo(() => new QueryClient(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ProfilePanel member={member} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * The account menu in the chrome — both account states.
 *
 * The difference between them is the whole point: login is optional and off by
 * default, and a sign-out on an install with no account is a control that does
 * nothing, so it is absent rather than present and inert.
 */
export function AccountMenuShowcases() {
  return (
    <PlaygroundSection
      title="Account Menu"
      description="Your face in the bottom-left of the sidebar, and the menu behind it. Open one: the header carries your name and your @handle, then View profile, Settings, and — only when this machine has a login — Sign out. Narrow the browser under 768px and the same menu becomes a bottom drawer."
    >
      <ShowcaseLabel>With a local account, and without one</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-center gap-6">
          <div className="flex flex-col items-center gap-2">
            <AccountMenu
              member={WITH_PHOTO}
              canSignOut
              onViewProfile={() => undefined}
              onOpenSettings={() => undefined}
              onSignOut={() => undefined}
            />
            <span className="text-muted-foreground text-xs">Signed in</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <AccountMenu
              member={{ ...SELF, handle: null }}
              canSignOut={false}
              onViewProfile={() => undefined}
              onOpenSettings={() => undefined}
              onSignOut={() => undefined}
            />
            <span className="text-muted-foreground text-xs">No login, no handle yet</span>
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        When DorkBot picked the name (DOR-1022). Open the menu: the header says so under your name,
        until you save one yourself in Settings &rsaquo; Profile. The second menu is the same
        install with an agent this machine cannot identify.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-center gap-6">
          <AccountMenu
            member={withSuggestedName(SELF, 'DorkBot')}
            canSignOut={false}
            onViewProfile={() => undefined}
            onOpenSettings={() => undefined}
            onSignOut={() => undefined}
          />
          <AccountMenu
            member={withSuggestedName(SELF, null)}
            canSignOut={false}
            onViewProfile={() => undefined}
            onOpenSettings={() => undefined}
            onSignOut={() => undefined}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Settings › Profile — the form, and the answers its handle field can get. */
export function ProfileTabShowcases() {
  return (
    <PlaygroundSection
      title="Profile Tab"
      description="The first tab in Settings: your photo, your name, your @handle, and the email your login carries. Each field saves on its own, because they fail for unrelated reasons — a handle can be taken while a name is perfectly fine. Saves here are inert; the playground has no server."
    >
      <ShowcaseLabel>With a photo</ShowcaseLabel>
      <ShowcaseDemo>
        <ProfilePanelDemo member={WITH_PHOTO} />
      </ShowcaseDemo>

      <ShowcaseLabel>No photo, no handle, no login</ShowcaseLabel>
      <ShowcaseDemo>
        <ProfilePanelDemo
          member={{ ...SELF, handle: null, person: { role: null, lastSeenAt: null } }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        A name an agent suggested (DOR-1022). The description says who picked it, and Save stays
        live for the name already in the box — pressing it unchanged is how somebody who likes
        DorkBot&rsquo;s pick claims it as their own and clears the note.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ProfilePanelDemo member={withSuggestedName(SELF, 'DorkBot')} />
      </ShowcaseDemo>

      <ShowcaseLabel>What the handle field says when a save is refused</ShowcaseLabel>
      <ShowcaseDemo>
        <ul className="space-y-2">
          {HANDLE_REFUSALS.map(({ code, server }) => (
            <li key={code} className="text-sm">
              <code className="text-muted-foreground text-xs">{code}</code>
              <p className="text-destructive text-xs">
                {handleErrorMessage(refusal(code, server), 'scout')}
              </p>
            </li>
          ))}
        </ul>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
