import { Button } from '@dork-labs/ui';
import { useCallback, useEffect, useState } from 'react';
import { Ban, MicOff, Trash2 } from 'lucide-react';
import type { CommunityWireBan, CommunityWireMute } from '@dorkos/shared/community-wire';
import { request } from '../../api.js';
import type { Member } from '../../types.js';
import { BanDialog, LiftBanDialog } from './BanDialogs.js';
import { MuteDialog } from '../../moderation/MuteDialog.js';

/** Run one change with the settings page's busy state and notices; resolves when it settles. */
export type Perform = (operation: () => Promise<unknown>, success: string) => Promise<void>;

/** Whether `me` outranks `member` for removal, mutes and bans: admins act on plain members. */
function outranks(me: Member, member: Member): boolean {
  if (member.memberId === me.memberId || member.role === 'owner') return false;
  return member.role === 'member' || me.role === 'owner';
}

/** Whole minutes as a short time of day or date, for when a mute ends. */
export function formatUntil(iso: string): string {
  const until = new Date(iso);
  const sameDay = until.toDateString() === new Date().toDateString();
  return sameDay
    ? until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : until.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

/**
 * The space's people, for owners and admins: roles, removal, mutes and bans, and the lists of
 * who is muted and who is banned now. It reads its own mutes and bans, and reads them again after
 * each change it makes.
 */
export function SpaceMembers({
  me,
  directory,
  hasMore,
  busy,
  perform,
  onMore,
}: {
  me: Member;
  directory: Member[];
  hasMore: boolean;
  busy: boolean;
  perform: Perform;
  onMore: () => void;
}) {
  const [bans, setBans] = useState<CommunityWireBan[]>([]);
  const [mutes, setMutes] = useState<CommunityWireMute[]>([]);
  // The member a ban or mute is being confirmed for, and the ban being lifted, while shown.
  const [banning, setBanning] = useState<Member | null>(null);
  const [muting, setMuting] = useState<Member | null>(null);
  const [lifting, setLifting] = useState<CommunityWireBan | null>(null);
  const reload = useCallback(async () => {
    const [banned, muted] = await Promise.all([
      request<{ bans: CommunityWireBan[] }>('/api/v1/bans'),
      request<{ mutes: CommunityWireMute[] }>('/api/v1/mutes'),
    ]).catch(() => [null, null] as const);
    if (banned) setBans(banned.bans);
    if (muted) setMutes(muted.mutes);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, directory]);
  const act = (operation: () => Promise<unknown>, success: string) =>
    void perform(operation, success).then(reload);
  return (
    <>
      <section className="panel">
        <h3>Space members</h3>
        {directory.map((member) => (
          <div
            className="row justify-between border-b border-[var(--line)] py-2"
            key={member.memberId}
          >
            <div>
              <strong>{member.displayName}</strong>
              <div className="small muted">
                @{member.handle} · {member.role}
              </div>
            </div>
            <div className="row">
              {me.role === 'owner' && member.memberId !== me.memberId && (
                <Button
                  variant="ghost"
                  aria-label={`${member.role === 'admin' ? 'Remove admin from' : 'Make'} ${member.displayName}${member.role === 'admin' ? '' : ' admin'}`}
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        request(`/api/v1/members/${member.memberId}/role`, 'PATCH', {
                          role: member.role === 'admin' ? 'member' : 'admin',
                        }),
                      member.role === 'admin' ? 'Admin removed.' : 'Admin granted.'
                    )
                  }
                >
                  {member.role === 'admin' ? 'Make member' : 'Make admin'}
                </Button>
              )}
              {member.memberId !== me.memberId && member.role === 'member' && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Remove ${member.displayName} from space`}
                  onClick={() => {
                    if (window.confirm(`Remove ${member.displayName} from this space?`))
                      act(
                        () => request(`/api/v1/members/${member.memberId}`, 'DELETE'),
                        'Member removed.'
                      );
                  }}
                >
                  <Trash2 size={16} />
                </Button>
              )}
              {outranks(me, member) && (
                <>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Mute ${member.displayName}`}
                    onClick={() => setMuting(member)}
                  >
                    <MicOff size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Ban ${member.displayName} from space`}
                    onClick={() => setBanning(member)}
                  >
                    <Ban size={16} />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
        {hasMore && (
          <Button variant="outline" className="mt-3" onClick={onMore}>
            Show more members
          </Button>
        )}
      </section>
      {muting && (
        <MuteDialog
          name={muting.displayName}
          busy={busy}
          onClose={() => setMuting(null)}
          onMute={(minutes) => {
            const target = muting;
            setMuting(null);
            act(
              () => request(`/api/v1/members/${target.memberId}/mute`, 'POST', { minutes }),
              'Member muted.'
            );
          }}
        />
      )}
      {banning && (
        <BanDialog
          name={banning.displayName}
          busy={busy}
          onClose={() => setBanning(null)}
          onBan={(reason) => {
            const target = banning;
            setBanning(null);
            act(
              () =>
                request(`/api/v1/members/${target.memberId}/ban`, 'POST', {
                  ...(reason ? { reason } : {}),
                }),
              'Member banned.'
            );
          }}
        />
      )}
      {lifting && (
        <LiftBanDialog
          name={lifting.displayName}
          busy={busy}
          onClose={() => setLifting(null)}
          onLift={() => {
            const target = lifting;
            setLifting(null);
            act(() => request(`/api/v1/bans/${target.id}`, 'DELETE'), 'Ban lifted.');
          }}
        />
      )}
      {mutes.length > 0 && (
        <section className="panel">
          <h3>Muted</h3>
          {mutes.map((mute) => (
            <div
              className="row justify-between border-b border-[var(--line)] py-2"
              key={mute.memberId}
            >
              <div>
                <strong>{mute.displayName}</strong>
                <div className="small muted">
                  @{mute.handle} · Until {formatUntil(mute.mutedUntil)}
                </div>
              </div>
              <Button
                variant="ghost"
                disabled={busy}
                aria-label={`Unmute ${mute.displayName}`}
                onClick={() =>
                  act(
                    () => request(`/api/v1/members/${mute.memberId}/mute`, 'DELETE'),
                    'Mute ended.'
                  )
                }
              >
                Unmute
              </Button>
            </div>
          ))}
        </section>
      )}
      {bans.length > 0 && (
        <section className="panel">
          <h3>Banned</h3>
          {bans.map((ban) => (
            <div className="row justify-between border-b border-[var(--line)] py-2" key={ban.id}>
              <div>
                <strong>{ban.displayName}</strong>
                <div className="small muted">
                  {ban.handle ? `@${ban.handle}` : 'No account'}
                  {ban.reason ? ` · ${ban.reason}` : ''}
                </div>
              </div>
              <Button
                variant="ghost"
                disabled={busy}
                aria-label={`Lift the ban on ${ban.displayName}`}
                onClick={() => setLifting(ban)}
              >
                Lift ban
              </Button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
