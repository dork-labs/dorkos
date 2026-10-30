/**
 * The one small text button an Inbox row answers with when the answer is not
 * yes or no ("Answer", "Confirm this setting"). Split out of `InboxDecisionRow`
 * to keep that file under its size limit.
 *
 * @module features/inbox/ui/InboxWordButton
 */
import { useId, type Ref } from 'react';
import { cn } from '@/layers/shared/lib';
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
  block = false,
  reachesInfo = false,
}: {
  label: string;
  description?: string;
  buttonRef: Ref<HTMLButtonElement>;
  onClick: () => void;
  disabled: boolean;
  /** This answer is the one in flight. */
  working: boolean;
  /** Under the text, full width and 44px tall: easy to hit on a phone (DOR-3288). */
  block?: boolean;
  /** A block button with an ⓘ beside the text: on a phone it reaches that edge too. */
  reachesInfo?: boolean;
}) {
  const hintId = useId();
  // On a phone a block button spans the whole row, from the icon's left edge
  // (28px icon + 10px gap) to the ⓘ's right edge (10px gap + 26px ⓘ) when
  // there is one, so its label never touches the button's edges.
  const blockClass = cn(
    'mt-2 h-11 w-full px-4 max-sm:-ml-[38px]',
    reachesInfo ? 'max-sm:w-[calc(100%+74px)]' : 'max-sm:w-[calc(100%+38px)]'
  );
  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size={block ? undefined : 'xs'}
        className={block ? blockClass : undefined}
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
