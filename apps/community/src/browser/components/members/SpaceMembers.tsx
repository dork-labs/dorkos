import { Button } from '@dork-labs/ui';
import { useState } from 'react';
import { Ban, Trash2 } from 'lucide-react';
import type { CommunityWireBan } from '@dorkos/shared/community-wire';
import { request } from '../../api.js';
import type { Member } from '../../types.js';
import { BanDialog, LiftBanDialog } from './BanDialogs.js';

/**
 * The space's member directory and its standing bans, for owners and admins: change a role,
 * remove, ban, and lift a ban. Every action runs through `perform`, which reports and refreshes.
 */
export function SpaceMembers({
  me,
  directory,
  hasMore,
  bans,
  busy,
  perform,
  onMore,
}: {
  me: Member;
  directory: Member[];
  /** More members wait behind the directory cursor. */
  hasMore: boolean;
  bans: CommunityWireBan[];
  busy: boolean;
  perform: (operation: () => Promise<unknown>, success: string) => Promise<void>;
  onMore: () => void;
}) {
  // The member a ban is being confirmed for, and the ban being lifted, while their dialog shows.
  const [banning, setBanning] = useState<Member | null>(null);
  const [lifting, setLifting] = useState<CommunityWireBan | null>(null);
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
                    void perform(
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
                      void perform(
                        () => request(`/api/v1/members/${member.memberId}`, 'DELETE'),
                        'Member removed.'
                      );
                  }}
                >
                  <Trash2 size={16} />
                </Button>
              )}
              {member.memberId !== me.memberId &&
                (member.role === 'member' || (member.role === 'admin' && me.role === 'owner')) && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Ban ${member.displayName} from space`}
                    onClick={() => setBanning(member)}
                  >
                    <Ban size={16} />
                  </Button>
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
      {banning && (
        <BanDialog
          name={banning.displayName}
          busy={busy}
          onClose={() => setBanning(null)}
          onBan={(reason) => {
            const target = banning;
            setBanning(null);
            void perform(
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
            void perform(() => request(`/api/v1/bans/${target.id}`, 'DELETE'), 'Ban lifted.');
          }}
        />
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
