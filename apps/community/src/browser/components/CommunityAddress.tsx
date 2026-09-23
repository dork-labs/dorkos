import { useRef, useState } from 'react';
import { Copy } from 'lucide-react';

/**
 * The address members open this community at, with a way to copy it: its short web address when
 * the host gave it one, otherwise its `/c/<id>` address. It only reaches members; it lets no
 * one in, so it is never offered as an invitation.
 */
export function CommunityAddress({ address }: { address: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(address);
      setCopy('copied');
    } catch {
      // Clipboard access can be refused; select the address so the person can copy it by hand.
      setCopy('failed');
      input.current?.focus();
      input.current?.select();
    }
  }
  return (
    <section className="panel">
      <h3>Community address</h3>
      <p className="small muted">
        Members open the community here. It doesn’t let anyone new in; use an invite for that.
      </p>
      <div className="field mb-2">
        <label htmlFor="community-address">Address</label>
        <div className="row">
          <input
            id="community-address"
            ref={input}
            className="min-w-0 flex-1"
            readOnly
            value={address}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button className="button shrink-0" type="button" onClick={() => void copyLink()}>
            <Copy size={15} /> {copy === 'copied' ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>
      <p className="small mb-0" aria-live="polite">
        {copy === 'copied'
          ? 'Link copied.'
          : copy === 'failed'
            ? 'This browser blocked copying. Copy the selected address by hand.'
            : ''}
      </p>
    </section>
  );
}
