import { Button, Input, Label } from '@dork-labs/ui';
import { useId, useRef, useState } from 'react';
import { Copy } from 'lucide-react';

/**
 * A read-only link with a Copy link button. A refused clipboard selects the link so the person
 * can copy it by hand, and says so.
 */
export function CopyableLink({ label, link }: { label: string; link: string }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopy('copied');
    } catch {
      // Clipboard access can be refused; select the link so the person can copy it by hand.
      setCopy('failed');
      input.current?.focus();
      input.current?.select();
    }
  }
  return (
    <>
      <div className="field mb-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="row">
          <Input
            id={id}
            ref={input}
            className="min-w-0 flex-1"
            readOnly
            value={link}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            variant="outline"
            className="shrink-0"
            type="button"
            onClick={() => void copyLink()}
          >
            <Copy size={15} /> {copy === 'copied' ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </div>
      <p className="small mb-0" aria-live="polite">
        {copy === 'copied'
          ? 'Link copied.'
          : copy === 'failed'
            ? 'This browser blocked copying. Copy the selected link by hand.'
            : ''}
      </p>
    </>
  );
}
