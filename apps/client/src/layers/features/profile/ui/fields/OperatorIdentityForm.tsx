/**
 * "What should I call you?" — a display name and an `@handle`, answered once
 * (DOR-677).
 *
 * Drawn by the three onboarding surfaces that put the question: the first-run
 * conversation, the getting-started card, and the one-time sidebar card.
 * Settings › Profile keeps its own two cards, which save separately because
 * there a person is changing ONE of them; see `useOperatorIdentityForm` for why
 * the question gets one confirm and what the two share beneath it.
 *
 * @module features/profile/ui/fields/OperatorIdentityForm
 */
import { useId, type FormEvent } from 'react';
import { Button, Input, Label } from '@/layers/shared/ui';
import { useOperatorIdentityForm } from '../../model/use-operator-identity-form';
import { FieldNote } from './ProfileFields';

/** Props for {@link OperatorIdentityForm}. */
export interface OperatorIdentityFormProps {
  /** Called once everything the person typed is saved. */
  onSaved: () => void;
  /** What the confirm button says when idle. */
  confirmLabel?: string;
  /** Called when the person declines. Omit to draw no skip button. */
  onSkip?: () => void;
  /** What the skip button says. */
  skipLabel?: string;
}

/**
 * The name-and-handle form.
 *
 * @param props - See {@link OperatorIdentityFormProps}.
 */
export function OperatorIdentityForm({
  onSaved,
  confirmLabel = 'Save',
  onSkip,
  skipLabel = 'Skip',
}: OperatorIdentityFormProps) {
  const form = useOperatorIdentityForm();
  const nameId = useId();
  const handleId = useId();
  const handleHintId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.canSave) return;
    void form.save().then((ok) => {
      if (ok) onSaved();
    });
  };

  const failed = form.nameError !== null || form.handleError !== null;
  let label = confirmLabel;
  if (form.saving) label = 'Saving…';
  else if (failed) label = 'Try again';

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="operator-identity-form">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={nameId} className="text-xs">
          Your name
        </Label>
        <Input
          id={nameId}
          value={form.name}
          maxLength={80}
          autoComplete="name"
          // Not `You`, which Settings uses: in a question that has not been
          // answered yet it reads as a value already filled in.
          placeholder="What you go by"
          disabled={!form.ready}
          onChange={(e) => form.setName(e.target.value)}
          className="h-8 text-sm"
        />
        {form.nameSuggestion && !form.nameError && (
          <p className="text-muted-foreground text-xs">
            {form.nameSuggestion}. Save it to make it yours.
          </p>
        )}
        {form.nameError && <FieldNote tone="error">{form.nameError}</FieldNote>}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={handleId} className="text-xs">
          Handle
        </Label>
        <div className="relative">
          <span
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm"
          >
            @
          </span>
          <Input
            id={handleId}
            value={form.handle}
            maxLength={64}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="yourname"
            aria-describedby={handleHintId}
            disabled={!form.ready}
            onChange={(e) => form.setHandle(e.target.value)}
            className="h-8 pl-6 text-sm"
          />
        </div>
        <p id={handleHintId} className="text-muted-foreground text-xs">
          What people and agents type after an @ to reach you.
        </p>
        {form.handleError && <FieldNote tone="error">{form.handleError}</FieldNote>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!form.canSave} data-testid="confirm-identity">
          {label}
        </Button>
        {onSkip && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onSkip}
            disabled={form.saving}
            data-testid="skip-identity"
          >
            {skipLabel}
          </Button>
        )}
      </div>
    </form>
  );
}
