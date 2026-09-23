/**
 * Tell every member of a held community what they can still do, and, when the host has
 * published one, the date after which it plans to delete the community.
 */
export function HoldBanner({ deletionNoticeAt }: { deletionNoticeAt: string | null }) {
  const date = deletionNoticeAt
    ? new Date(deletionNoticeAt).toLocaleDateString(undefined, { dateStyle: 'long' })
    : null;
  return (
    <div className="notice m-3" role="status">
      <strong>This community is on hold by its host. You can read it but not post.</strong>
      {date && (
        <p className="mt-1 mb-0">
          The host plans to delete it after {date}. The owner can export it until then.
        </p>
      )}
    </div>
  );
}
