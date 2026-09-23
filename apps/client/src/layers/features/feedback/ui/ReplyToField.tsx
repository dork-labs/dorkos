import { useId } from 'react';
import { User, VenetianMask } from 'lucide-react';
import { MAX_FEEDBACK_CONTACT_LEN } from '@dorkos/shared/telemetry-events';
import { Input, Label } from '@/layers/shared/ui';
import { looksLikeEmail } from '../lib/reply-email';

interface ReplyToFieldProps {
  /** The signed-in user, or `null` when nobody is (login off, or signed out). */
  currentUser: { email: string } | null;
  /** Whether a signed-in reporter chose to send without their identity. */
  anonymous: boolean;
  /** Flip {@link ReplyToFieldProps.anonymous}. */
  onToggleAnonymous: () => void;
  /** The address a signed-out reporter typed. */
  contact: string;
  /** Update {@link ReplyToFieldProps.contact}. */
  onContactChange: (value: string) => void;
}

/**
 * Who the DorkOS team can write back to (feedback-form-redesign §2.5).
 *
 * Signed in, one quiet line: "Replying to you@…", with a way to send
 * anonymously. Signed out, a visible "Your email" field, because with no
 * account an address typed here is the only way a report can ever be answered.
 * A value that does not look like an email is said so beside the field; it
 * never blocks the report.
 */
export function ReplyToField({
  currentUser,
  anonymous,
  onToggleAnonymous,
  contact,
  onContactChange,
}: ReplyToFieldProps) {
  const emailId = useId();
  const emailHintId = useId();

  if (currentUser) {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {anonymous ? (
            <VenetianMask className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <User className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate">
            {anonymous ? 'Sending anonymously' : `Replying to ${currentUser.email}`}
          </span>
          <button
            type="button"
            onClick={onToggleAnonymous}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm underline underline-offset-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
          >
            {anonymous ? 'Use my account' : 'Send anonymously'}
          </button>
        </div>
        {anonymous && (
          <p className="text-muted-foreground text-xs">
            Your report won’t include your name or email, so we can’t write back. You can still
            follow it under Your reports.
          </p>
        )}
      </div>
    );
  }

  const looksWrong = contact.trim().length > 0 && !looksLikeEmail(contact);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={emailId} className="text-xs">
        Your email
      </Label>
      <Input
        id={emailId}
        type="email"
        inputMode="email"
        autoComplete="email"
        value={contact}
        onChange={(e) => onContactChange(e.target.value)}
        placeholder="you@example.com"
        maxLength={MAX_FEEDBACK_CONTACT_LEN}
        aria-describedby={emailHintId}
        // Enter in a one-line field submits its form by default, which would
        // send a report whose words are unfinished. The send shortcut
        // (⌘/Ctrl+Enter) still reaches the dialog.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) e.preventDefault();
        }}
        aria-invalid={looksWrong || undefined}
      />
      <p id={emailHintId} className="text-muted-foreground text-xs">
        {looksWrong
          ? 'That doesn’t look like an email yet, so we couldn’t write back.'
          : 'So we can tell you when it’s fixed. We remember it for next time.'}
      </p>
    </div>
  );
}
