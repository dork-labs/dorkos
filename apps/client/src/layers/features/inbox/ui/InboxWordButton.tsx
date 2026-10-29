/**
 * The one small text button an Inbox row answers with when the answer is not
 * yes or no ("Answer", "Confirm this setting"). Split out of `InboxDecisionRow`
 * to keep that file under its size limit.
 *
 * @module features/inbox/ui/InboxWordButton
 */
import { useId, type Ref } from 'react';
import { Button, Spinner } from '@/layers/shared/ui';

/**
 * The word button, with a spinner while its answer is in flight and, when it
 * has one, a description a screen reader hears even if the words sit behind ⓘ.
 */
export function InboxWordButton({
  label,
  description,
  buttonRef,
  onClick,
  disabled,
  working,
}: {
  label: string;
  description?: string;
  buttonRef: Ref<HTMLButtonElement>;
  onClick: () => void;
  disabled: boolean;
  /** This answer is the one in flight. */
  working: boolean;
}) {
  const hintId = useId();
  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size="xs"
        responsive={false}
        onClick={onClick}
        disabled={disabled}
        aria-describedby={description ? hintId : undefined}
      >
        {working && <Spinner size="xs" />}
        {label}
      </Button>
      {description && (
        <span id={hintId} className="sr-only">
          {description}
        </span>
      )}
    </>
  );
}
