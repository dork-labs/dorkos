import { useEffect, useState } from 'react';
import type { Member, Problem, Seat } from '@dork-labs/cloud-api';
import type { CloudSeatActionResponse } from '@dorkos/shared/cloud-schemas';
import { Badge, Button, FieldCard, FieldCardContent, Skeleton } from '@/layers/shared/ui';
import { formatRelativeTime } from '@/layers/shared/lib';
import {
  useCloudMembers,
  useCloudOrgs,
  useCloudSeats,
  useSeatActions,
} from '../model/use-cloud-plan';

/**
 * Seat management — the seats this organization holds, and the two actions that
 * change them.
 *
 * **When an action needs a plan change, the app does not say so in its own
 * words.** The service answers with the contract's problem envelope, and this
 * renders the `title`, the `detail` and the `requiredPlanDisplayName` it was
 * given. That is the only reason this component can explain a refusal at all
 * without knowing a single plan exists.
 *
 * Presence is deliberately absent from these rows: until the managed remote
 * socket exists the service can only answer `offline` or `unknown` from a
 * 15-minute heartbeat, and a status dot driven by that is worse than no dot.
 */
export function SeatManagement() {
  const { data: orgs } = useCloudOrgs();
  const [orgId, setOrgId] = useState<string | null>(null);
  const available = orgs?.available ? orgs.orgs : [];

  // Settle on an organization as soon as one is known. A person in exactly one
  // organization never sees a chooser — there is nothing to choose.
  useEffect(() => {
    if (orgId === null && available.length > 0) setOrgId(available[0]!.id);
  }, [orgId, available]);

  const { data: seats, isLoading, isError } = useCloudSeats(orgId);
  const { data: members } = useCloudMembers(orgId);
  const { assign, release } = useSeatActions(orgId);
  const [refusal, setRefusal] = useState<Problem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (!orgs?.available) return null;
  if (isLoading && !seats) return <Skeleton className="h-24 w-full" />;
  if (isError) {
    return <p className="text-muted-foreground text-sm">Couldn’t read your seats just now.</p>;
  }
  if (!seats?.available) return null;

  const candidates = members?.available ? members.members : [];

  /**
   * Record whatever the write answered.
   *
   * Every failure path lands here — a refusal the service described, a message
   * it could not, and a thrown transport error — because a money-adjacent write
   * that quietly does nothing is the one outcome worth ruling out. Nothing is
   * left to an unhandled rejection.
   */
  const settle = (result: CloudSeatActionResponse) => {
    setRefusal(null);
    setFailure(null);
    if (result.ok) return;
    if ('problem' in result) setRefusal(result.problem);
    else setFailure(result.message);
  };

  const onRelease = async (seatId: string) => {
    try {
      settle(await release.mutateAsync(seatId));
    } catch {
      setRefusal(null);
      setFailure('Couldn’t reach your account just now. Nothing changed.');
    }
  };

  const onAssign = async (seatId: string, userId: string) => {
    try {
      settle(await assign.mutateAsync({ seatId, subject: { kind: 'user', id: userId } }));
    } catch {
      setRefusal(null);
      setFailure('Couldn’t reach your account just now. Nothing changed.');
    }
  };

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs tracking-wide uppercase">Seats</p>
          {available.length > 1 && (
            <select
              className="border-input bg-background rounded-md border px-2 py-1 text-sm"
              aria-label="Organization"
              value={orgId ?? ''}
              onChange={(event) => setOrgId(event.target.value)}
            >
              {available.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {seats.seats.length === 0 ? (
          <p className="text-muted-foreground text-sm">No seats yet.</p>
        ) : (
          <ul className="divide-y">
            {seats.seats.map((seat) => (
              <li key={seat.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{seatLabel(seat)}</p>
                  <p className="text-muted-foreground text-xs">
                    {/* "Assigned <when>", never a status dot — see the component doc. */}
                    {seat.assignedAt
                      ? `Assigned ${formatRelativeTime(seat.assignedAt)}`
                      : 'Not assigned'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="secondary">{seat.status}</Badge>
                  {seat.status === 'assigned' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={release.isPending}
                      onClick={() => void onRelease(seat.id)}
                    >
                      Release
                    </Button>
                  ) : (
                    // An unassigned seat has no subject to put back, so the app
                    // offers the people it knows about rather than asking for an
                    // identifier. With no member list it offers nothing at all,
                    // which is the honest answer to "assign this to whom?".
                    candidates.length > 0 && (
                      <select
                        className="border-input bg-background rounded-md border px-2 py-1 text-sm"
                        aria-label="Assign this seat to"
                        defaultValue=""
                        disabled={assign.isPending}
                        onChange={(event) => {
                          const userId = event.target.value;
                          if (userId !== '') void onAssign(seat.id, userId);
                        }}
                      >
                        <option value="">Assign to…</option>
                        {candidates.map((member) => (
                          <option key={member.id} value={member.userId}>
                            {memberLabel(member, candidates)}
                          </option>
                        ))}
                      </select>
                    )
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {refusal !== null && (
          <div className="border-destructive/40 bg-destructive/5 space-y-1 rounded-md border px-3 py-2">
            {/* Every word below is the service's. */}
            <p className="text-sm font-medium">{refusal.title}</p>
            {refusal.detail !== undefined && <p className="text-sm">{refusal.detail}</p>}
            {refusal.requiredPlanDisplayName !== undefined && (
              <p className="text-muted-foreground text-sm">
                This needs {refusal.requiredPlanDisplayName}.
              </p>
            )}
          </div>
        )}

        {failure !== null && (
          <div className="border-destructive/40 bg-destructive/5 rounded-md border px-3 py-2">
            <p className="text-sm">{failure}</p>
          </div>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}

/**
 * What to call a member in the assign picker.
 *
 * **The contract carries no display name for a member.** `MemberSchema` is an
 * id, an org id, a user id, a role and a timestamp — no name, no email — and no
 * `/v1` route 0.75.1 types resolves another person's account. So the honest
 * answer is the role, which is the one field here that means something to a
 * human, and the opaque reference only where it has to disambiguate two people
 * holding the same role. Naming a member properly needs a display field on the
 * wire; that is a listed follow-up, not something to invent here.
 *
 * @param member - The member to label.
 * @param all - Every candidate, to decide whether the role alone is ambiguous.
 */
function memberLabel(member: Member, all: Member[]): string {
  const sameRole = all.filter((m) => m.role === member.role);
  return sameRole.length === 1 ? member.role : `${member.role} · ${member.userId}`;
}

/**
 * What to call a seat on screen.
 *
 * Its address when it has one, and otherwise what kind of thing it holds. The
 * opaque identifier is never shown: it means nothing to the person reading it.
 *
 * @param seat - The seat to label.
 */
function seatLabel(seat: Seat): string {
  if (seat.address !== null) return seat.address.canonical;
  return seat.kind === 'person' ? 'Person' : 'Agent';
}
