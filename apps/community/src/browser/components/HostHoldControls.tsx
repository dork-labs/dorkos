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
};

type Dialog = 'hold' | 'notice' | 'delete' | null;

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
      {community.lifecycle === 'deletion_pending' && community.deletionRequestedBy && (
        <p className="small muted mb-2">
          Deletion requested by the {community.deletionRequestedBy}.
        </p>
      )}
      <div className="row flex-wrap gap-2">
        {holdable && (
          <button className="button" disabled={busy} onClick={() => setDialog('hold')}>
            Hold
          </button>
        )}
        {held && (
          <>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void perform(() => lifecycle({ action: 'release' }), `Released ${community.name}.`)
              }
            >
              Release hold
            </button>
            <button className="button" disabled={busy} onClick={() => setDialog('notice')}>
              {community.deletionNoticeAt ? 'Change notice' : 'Publish deletion notice'}
            </button>
            {noticePassed && (
              <button className="button danger" disabled={busy} onClick={() => setDialog('delete')}>
                Delete
              </button>
            )}
          </>
        )}
        {community.lifecycle === 'deletion_pending' && community.deletionRequestedBy === 'host' && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await request(`/api/v1/host/communities/${community.id}/deletion`, 'DELETE');
              }, `Deletion cancelled. ${community.name} is on hold again.`)
            }
          >
            Cancel deletion
          </button>
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
            <label htmlFor={`notice-${community.id}`}>Delete after (optional)</label>
            <input
              id={`notice-${community.id}`}
              type="date"
              min={minimum}
              value={day}
              onChange={(event) => setDay(event.target.value)}
            />
          </div>
          <div className="row justify-end gap-2">
            <button className="button" onClick={close}>
              Cancel
            </button>
            <button
              className={dialog === 'hold' ? 'button danger' : 'button primary'}
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
            </button>
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
            <label htmlFor={`delete-suffix-${community.id}`}>
              Type the last eight characters of its ID ({community.id.slice(-8)})
            </label>
            <input
              id={`delete-suffix-${community.id}`}
              value={suffix}
              autoComplete="off"
              onChange={(event) => setSuffix(event.target.value.trim())}
            />
          </div>
          <div className="row justify-end gap-2">
            <button className="button" onClick={close}>
              Cancel
            </button>
            <button
              className="button danger"
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
            </button>
          </div>
        </FocusDialog>
      )}
    </>
  );
}
