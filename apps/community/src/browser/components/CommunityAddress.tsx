import { CopyableLink } from '../connect/CopyableLink.js';

/**
 * The address members open this community at, with a way to copy it: its short web address when
 * the host gave it one, otherwise its `/c/<id>` address. It only reaches members; it lets no
 * one in, so it is never offered as an invitation.
 */
export function CommunityAddress({ address }: { address: string }) {
  return (
    <section className="panel">
      <h3>Community address</h3>
      <p className="small muted">
        Members open the community here. It doesn’t let anyone new in; use an invite for that.
      </p>
      <CopyableLink label="Address" link={address} />
    </section>
  );
}
