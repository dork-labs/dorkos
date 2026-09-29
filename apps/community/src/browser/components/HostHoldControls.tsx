import { Button, Input, Label } from '@dork-labs/ui';
import { useState } from 'react';
import { request } from '../api.js';
import { FocusDialog } from './CommunityAdministration.js';

/** The fields of a host community record these controls act on. */
export type HoldableCommunity = {
  id: string;
  name: string;
  lifecycle: string;
  lifecycleVersion: number;
  deletionNoticeAt: string | null;
  deletionRequestedBy: 'owner' | 'host' | null;
  /** The host's takedown of the whole community, while it can still be reversed. */
  takedownId?: string | null;
};

type Dialog = 'hold' | 'notice' | 'delete' | 'reverse' | null;

/** The earliest day the picker offers: the host's minimum notice, counted in whole UTC days. */
function earliestNotice(now: number, days: number): string {
  return new Date(now + (days + 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

/**
 * A notice runs to the end of the chosen day in UTC, the same instant for every member and
 * never shorter than it reads.
 */
function noticeAt(day: string): string | null {
  return day ? `${day}T23:59:59.999Z` : null;
}

/** A notice as people read it: its UTC day, said as such. */
export function noticeDay(value: string): string {
  return `${new Date(value).toLocaleDateString(undefined, { dateStyle: 'long', timeZone: 'UTC' })} (end of day, UTC)`;
}

/**
 * Hold, release, publish a deletion notice, and delete after it: the host's gentler tools.
 * A hold keeps members reading and the owner exporting; deletion comes only after the notice
 * date members can see.
 */
export function HostHoldControls({
  community,
  busy,
  noticeDays,
  perform,
}: {
  community: HoldableCommunity;
  busy: boolean;
  /** This host's least notice before a held community may be deleted. */
  noticeDays: number;
  perform: (work: () => Promise<void>, success: string) => Promise<void>;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [day, setDay] = useState('');
  const [suffix, setSuffix] = useState('');
  const [password, setPassword] = useState('');
  const takenDown = community.lifecycle === 'deletion_pending' && Boolean(community.takedownId);
  // Read once per mount: the page reloads the record after every change it makes.
  const [now] = useState(() => Date.now());
  const held = community.lifecycle === 'held';
  // A suspended community can be held in one step: it goes straight to the hold, never live.
  const holdable =
    community.lifecycle === 'active' ||
    community.lifecycle === 'archived' ||
    community.lifecycle === 'suspended';
  const noticePassed =
    held && community.deletionNoticeAt !== null && Date.parse(community.deletionNoticeAt) <= now;
  const lifecycle = async (body: Record<string, unknown>) => {
    await request(`/api/v1/host/communities/${community.id}/lifecycle`, 'PATCH', {
      lifecycleVersion: community.lifecycleVersion,
      ...body,
    });
  };
  const close = () => {
    setDialog(null);
    setDay('');
    setSuffix('');
    setPassword('');
  };
  const minimum = earliestNotice(now, noticeDays);

  return (
    <>
      {held && (
        <p className="small muted mb-2">
          On hold.{' '}
          {community.deletionNoticeAt
            ? `Deletion notice: ${noticeDay(community.deletionNoticeAt)}.`
            : 'No deletion notice published.'}
        </p>
      )}
      {takenDown ? (
        <p className="small muted mb-2">
          Taken down. It will be deleted when the reversal window ends, once its copy for the
          authorities is saved.
        </p>
      ) : (
        community.lifecycle === 'deletion_pending' &&
        community.deletionRequestedBy && (
          <p className="small muted mb-2">
            Deletion requested by the {community.deletionRequestedBy}.
          </p>
        )
      )}
      <div className="row flex-wrap gap-2">
        {holdable && (
          <Button variant="outline" disabled={busy} onClick={() => setDialog('hold')}>
            Hold
          </Button>
        )}
        {held && (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(() => lifecycle({ action: 'release' }), `Released ${community.name}.`)
              }
            >
              Release hold
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setDialog('notice')}>
              {community.deletionNoticeAt ? 'Change notice' : 'Publish deletion notice'}
            </Button>
            {noticePassed && (
              <Button variant="destructive" disabled={busy} onClick={() => setDialog('delete')}>
                Delete
              </Button>
            )}
          </>
        )}
        {takenDown && (
          <Button variant="outline" disabled={busy} onClick={() => setDialog('reverse')}>
            Reverse takedown
          </Button>
        )}
        {!takenDown &&
          community.lifecycle === 'deletion_pending' &&
          community.deletionRequestedBy === 'host' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await request(`/api/v1/host/communities/${community.id}/deletion`, 'DELETE');
                }, `Deletion cancelled. ${community.name} is on hold again.`)
              }
            >
              Cancel deletion
            </Button>
          )}
      </div>
      {(dialog === 'hold' || dialog === 'notice') && (
        <FocusDialog
          title={
            dialog === 'hold' ? `Hold ${community.name}?` : `Deletion notice for ${community.name}`
          }
          onClose={close}
        >
          <p>
            {dialog !== 'hold'
              ? `Members see this date on every channel. You can move it later or clear it, but never closer than ${noticeDays} days away.`
              : community.lifecycle === 'suspended'
                ? 'The community goes straight from suspended to on hold. Members can read it again and the owner can export, but no one can post, join, or change settings.'
                : 'Members can still read and the owner can still export, but no one can post, join, or change settings. Every connected DorkOS installation and agent loses access now.'}
          </p>
          <div className="field">
            <Label htmlFor={`notice-${community.id}`}>Delete after (optional)</Label>
            <input
              id={`notice-${community.id}`}
              type="date"
              min={minimum}
              value={day}
              onChange={(event) => setDay(event.target.value)}
            />
          </div>
          <div className="row justify-end gap-2">
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              variant={dialog === 'hold' ? 'destructive' : 'default'}
              disabled={busy || (day !== '' && day < minimum)}
              onClick={() =>
                void perform(
                  () =>
                    lifecycle({
                      action: dialog === 'hold' ? 'hold' : 'set_notice',
                      deletionNoticeAt: noticeAt(day),
                    }),
                  dialog === 'hold' ? `${community.name} is on hold.` : 'Deletion notice saved.'
                ).finally(close)
              }
            >
              {dialog === 'hold' ? 'Hold community' : day ? 'Save notice' : 'Clear notice'}
            </Button>
          </div>
        </FocusDialog>
      )}
      {dialog === 'reverse' && community.takedownId && (
        <FocusDialog title={`Reverse the takedown of ${community.name}?`} onClose={close}>
          <p>
            The deletion stops and the community is suspended, not reopened. Every connection stays
            revoked until you resume it and people reconnect. The copy kept for the authorities is
            not deleted.
          </p>
          <div className="field">
            <Label htmlFor={`reverse-password-${community.id}`}>Your password</Label>
            <Input
              id={`reverse-password-${community.id}`}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="row justify-end gap-2">
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={busy || password === ''}
              onClick={() =>
                void perform(async () => {
                  await request(`/api/v1/host/takedowns/${community.takedownId}/reverse`, 'POST', {
                    lifecycleVersion: community.lifecycleVersion,
                    password,
                  });
                }, `${community.name} is suspended. Resume it when it is ready.`).finally(close)
              }
            >
              Reverse takedown
            </Button>
          </div>
        </FocusDialog>
      )}
      {dialog === 'delete' && (
        <FocusDialog title={`Delete ${community.name}?`} onClose={close}>
          <p>
            This permanently deletes the community and everything in it after seven more days. You
            can cancel during those seven days. The owner cannot.
          </p>
          <div className="field">
            <Label htmlFor={`delete-suffix-${community.id}`}>
              Type the last eight characters of its ID ({community.id.slice(-8)})
            </Label>
            <Input
              id={`delete-suffix-${community.id}`}
              value={suffix}
              autoComplete="off"
              onChange={(event) => setSuffix(event.target.value.trim())}
            />
          </div>
          <div className="row justify-end gap-2">
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || suffix !== community.id.slice(-8)}
              onClick={() =>
                void perform(async () => {
                  await request(`/api/v1/host/communities/${community.id}/deletion`, 'POST', {
                    lifecycleVersion: community.lifecycleVersion,
                    confirmIdSuffix: suffix,
                  });
                }, `${community.name} will be deleted in seven days.`).finally(close)
              }
            >
              Delete community
            </Button>
          </div>
        </FocusDialog>
      )}
    </>
  );
}
