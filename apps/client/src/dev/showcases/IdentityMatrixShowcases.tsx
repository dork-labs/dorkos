/**
 * The whole identity convention on one screen.
 *
 * Everything here is driven by `kind` (and `origin`, which only a person has).
 * No row sets `shape`, `variant` or `badge` — a matrix that hand-mapped those
 * would keep looking right the day the mapping broke, which is the exact
 * failure `kind` was added to end (spec `identity-consistency` §W4.3).
 *
 * @module dev/showcases/IdentityMatrixShowcases
 */
import { Fragment, type ComponentProps } from 'react';
import type { AuthorKind } from '@dorkos/shared/room-schemas';
import { IdentityAvatar, MentionPill } from '@/layers/shared/ui';
import { teamMemberFace } from '@/layers/entities/team';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  IDENTITY_STATUSES,
  MOCK_IDENTITIES,
  MOCK_TEAM_ROSTER,
  type MockIdentity,
} from '../mock-samples';

/** The three things a disc can have on it, in the order the disc prefers them. */
type Face = 'photo' | 'emoji' | 'letter';

const FACES: readonly Face[] = ['photo', 'emoji', 'letter'];

/** The photo every row in this matrix borrows, so there is one image on the page. */
const PHOTO = MOCK_IDENTITIES.photographed.imageUrl;

/** One row of the matrix: a kind, and the faces that kind can actually wear. */
interface MatrixRow {
  label: string;
  kind: AuthorKind;
  origin?: ComponentProps<typeof IdentityAvatar>['origin'];
  color: string;
  emoji: string;
  fallback: string;
  /**
   * Which of {@link FACES} this kind can really carry. A room's own voice has
   * neither a photo nor an emoji — it is a name — and a cell drawn for it would
   * be a state the product cannot produce, shown as if it could.
   */
  faces: readonly Face[];
}

const ROWS: readonly MatrixRow[] = [
  {
    label: 'agent',
    kind: 'agent',
    color: MOCK_IDENTITIES.warden.color!,
    emoji: MOCK_IDENTITIES.warden.emoji!,
    fallback: 'W',
    faces: ['photo', 'emoji', 'letter'],
  },
  {
    label: 'person · here',
    kind: 'human',
    origin: 'local',
    color: MOCK_IDENTITIES.photographed.color!,
    emoji: MOCK_IDENTITIES.photographed.emoji!,
    fallback: 'D',
    faces: ['photo', 'emoji', 'letter'],
  },
  {
    label: 'person · bridged',
    kind: 'human',
    origin: { platform: 'telegram' },
    color: '#0ea5e9',
    emoji: '🛰',
    fallback: 'M',
    faces: ['photo', 'emoji', 'letter'],
  },
  {
    label: 'the room itself',
    kind: 'system',
    color: '#71717a',
    emoji: '',
    fallback: 'G',
    faces: ['letter'],
  },
];

/** The props one cell passes — never `shape`, never `variant`, never `badge`. */
function cellProps(row: MatrixRow, face: Face): ComponentProps<typeof IdentityAvatar> {
  return {
    kind: row.kind,
    origin: row.origin,
    color: row.color,
    fallback: row.fallback,
    ...(face === 'photo' ? { imageUrl: PHOTO } : {}),
    ...(face === 'emoji' ? { emoji: row.emoji } : {}),
    size: 'md',
  };
}

/** A caption under whatever it wraps, so the grid reads as a grid. */
function Cell({ children }: { children: React.ReactNode }) {
  return <div className="flex h-12 items-center justify-center">{children}</div>;
}

/** Whether this mock says its agent is mid-turn right now. */
function isWorking(identity: MockIdentity): boolean {
  return identity.agent?.working != null;
}

/**
 * The two kinds the state matrix is drawn for: an agent, and a person bridged
 * in from somewhere else.
 *
 * The bridged person is the load-bearing half. It is the one identity that
 * wears something in BOTH corners at once — the platform's mark bottom-right,
 * the state dot top-right — so it is the row that proves the two corners have
 * separate jobs and neither has quietly taken the other's.
 */
const STATE_ROWS = [
  { label: 'agent', props: { kind: 'agent', color: '#6366f1', emoji: '🔍' } },
  {
    label: 'person · bridged',
    props: {
      kind: 'human',
      origin: { platform: 'telegram' },
      color: '#0ea5e9',
      fallback: 'M',
    },
  },
] as const satisfies readonly { label: string; props: ComponentProps<typeof IdentityAvatar> }[];

/** The kind × face grid, the mention cast, and the roster — all from `kind`. */
export function IdentityShapeMatrixShowcase() {
  return (
    <PlaygroundSection
      title="Identity Shape Matrix"
      description="The whole convention at one glance: square and filled with a Bot mark is an agent, a tinted circle is a person, a circle carrying a platform mark is somebody bridged in, and the room's own voice is a plain circle. Every cell is drawn by passing kind — nothing here sets shape, variant or badge — so a mapping that breaks shows up here as the wrong silhouette rather than as a passing test."
    >
      <ShowcaseLabel>Kind × face — photo first, then emoji, then the letter</ShowcaseLabel>
      <ShowcaseDemo>
        {/* The empty cells are not gaps: a room's own voice has no photo and no
            emoji to draw, so drawing one would advertise a state the product
            cannot produce. */}
        <div className="grid grid-cols-[8rem_repeat(3,4rem)] items-center gap-x-4 gap-y-3">
          <span />
          {FACES.map((face) => (
            <span key={face} className="text-muted-foreground text-center text-[10px]">
              {face}
            </span>
          ))}
          {ROWS.map((row) => (
            <Fragment key={row.label}>
              <span className="text-muted-foreground text-xs">{row.label}</span>
              {FACES.map((face) => (
                <Cell key={face}>
                  {row.faces.includes(face) ? (
                    <IdentityAvatar {...cellProps(row, face)} />
                  ) : (
                    <span className="text-muted-foreground/40 text-xs">—</span>
                  )}
                </Cell>
              ))}
            </Fragment>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Kind × state — the top-right corner, and everything it is allowed to say
      </ShowcaseLabel>
      <ShowcaseDemo>
        {/* Three layers, three homes, and this is the top one. The corner
            top-right is live state; the corner bottom-right is identity (the
            Bot mark, a platform's logo); the row's trailing marks say where a
            session came from. Nothing here is mesh health — an agent seen
            within the last hour is not an agent doing something, and the disc
            spent a release saying it was.

            Only `working` moves. Motion is what the word "now" is made of, so a
            still amber dot is how "waiting on you" reads as a state rather than
            as a turn still running.

            And every dot here says in words what it says in colour (spec R2):
            it is the one mark on the disc that is not aria-hidden, because it
            is the only one whose whole content is a hue. The row under it is
            the second half of that pairing — a status dot always sits beside a
            verb line, a tooltip or a Now item. */}
        <div className="grid grid-cols-[8rem_repeat(4,5rem)] items-center gap-x-4 gap-y-3">
          <span />
          {IDENTITY_STATUSES.map(({ status, label }) => (
            <span key={status} className="text-muted-foreground text-center text-[10px]">
              {label}
            </span>
          ))}
          {STATE_ROWS.map((row) => (
            <Fragment key={row.label}>
              <span className="text-muted-foreground text-xs">{row.label}</span>
              {IDENTITY_STATUSES.map(({ status }) => (
                <Cell key={status}>
                  <IdentityAvatar {...row.props} status={status} size="md" />
                </Cell>
              ))}
            </Fragment>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        The whole cast — every state the mocks hold, as a disc and as the mention that points at it
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries(MOCK_IDENTITIES).map(([key, identity]) => (
            <div key={key} className="flex items-center gap-3">
              <IdentityAvatar
                kind={identity.kind}
                origin={identity.origin}
                color={identity.color ?? '#71717a'}
                emoji={identity.emoji}
                imageUrl={identity.imageUrl}
                fallback={identity.displayName[0]}
                status={isWorking(identity) ? 'working' : 'idle'}
                size="md"
              />
              <div className="min-w-0">
                <MentionPill
                  kind={identity.kind}
                  label={identity.displayName}
                  handle={identity.handle}
                  color={identity.color}
                  origin={identity.origin}
                  resolved
                />
                <p className="text-muted-foreground truncate text-[10px]">
                  {identity.handle ? `@${identity.handle}` : 'no handle'}
                  {isWorking(identity) ? ' · working' : ''}
                </p>
              </div>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        The roster, resolved the way every roster surface resolves it — through teamMemberFace
      </ShowcaseLabel>
      <ShowcaseDemo>
        {/* Not a second mapping: this is the function the Team page, the cards,
            the cluster headers and the profile drawer all call, so a row that
            draws wrong here draws wrong on all of them. */}
        <div className="flex flex-wrap gap-4">
          {MOCK_TEAM_ROSTER.map((member) => {
            const face = teamMemberFace(member);
            return (
              <div key={member.id} className="flex w-32 flex-col items-center gap-2 text-center">
                <IdentityAvatar {...face} size="md" />
                <span className="text-muted-foreground truncate text-[10px]">
                  {member.handle ? `@${member.handle}` : `${member.displayName} · no handle`}
                </span>
              </div>
            );
          })}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
