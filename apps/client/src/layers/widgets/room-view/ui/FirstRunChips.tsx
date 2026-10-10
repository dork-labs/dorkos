import { useCallback, useState } from 'react';
import { OwnAiList } from '@/layers/features/onboarding';
import { DoeInferenceForm, renderRuntimeConnect } from '@/layers/features/runtime-connect';
import {
  newPendingId,
  useComposerFocusStore,
  usePostToRoom,
  useRoomDraftStore,
} from '@/layers/entities/room';
import { useSettingsDeepLink } from '@/layers/shared/model';
import {
  Button,
  PromptSuggestionChips,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import type { FirstRunChipsMode } from '../model/use-first-run-chips';

/** DorkBot's handle, which every chip addresses so the room's lead is never guessed. */
const DORKBOT_MENTION = '@dorkbot';

/** The first jobs offered, word for word as the spec names them. */
const BUILD_TRACKER = 'Build me a tracker for my customers';
const PLAN_BOARD = 'Make a daily plan board';
const SOMETHING_ELSE = 'Something else';
const STARTERS = [BUILD_TRACKER, PLAN_BOARD, SOMETHING_ELSE] as const;

/** Props for {@link FirstRunChips}. */
export interface FirstRunChipsProps {
  /** The room the chips post into: #team. */
  roomId: string;
  /** Which strip to draw (`useFirstRunChips`). */
  mode: FirstRunChipsMode;
}

/**
 * The strip under DorkBot's first-run welcome in #team (spec
 * `one-minute-onboarding` §2.4).
 *
 * With AI connected, a chip is the person's first message: it posts
 * `@dorkbot <chip>` as them, and DorkBot's reply is the first real turn.
 * "Something else" puts `@dorkbot ` in the composer and the caret after it.
 * With no AI yet, the strip offers the two ways to connect instead: the DorkOS
 * account in Settings, and the Own AI list in a dialog.
 */
export function FirstRunChips({ roomId, mode }: FirstRunChipsProps) {
  const post = usePostToRoom();
  const settings = useSettingsDeepLink();
  const [ownAiOpen, setOwnAiOpen] = useState(false);

  const press = useCallback(
    (line: string) => {
      if (line === SOMETHING_ELSE) {
        useRoomDraftStore.getState().set(roomId, `${DORKBOT_MENTION} `);
        useComposerFocusStore.getState().requestFocus(roomId);
        return;
      }
      post.mutate({ roomId, text: `${DORKBOT_MENTION} ${line}`, clientId: newPendingId() });
    },
    [roomId, post]
  );

  if (mode === 'starters') {
    return (
      <div className="w-full px-[var(--msg-padding-x)] pb-1" data-testid="first-run-chips">
        <PromptSuggestionChips
          suggestions={STARTERS}
          onChipClick={press}
          ariaLabel="First jobs for DorkBot"
          size="comfortable"
        />
      </div>
    );
  }

  return (
    <div
      className="flex w-full flex-wrap gap-2 px-[var(--msg-padding-x)] pb-1"
      data-testid="first-run-connect-chips"
    >
      <Button size="sm" onClick={() => settings.open('account')}>
        Continue with DorkOS
      </Button>
      <Button size="sm" variant="outline" onClick={() => setOwnAiOpen(true)}>
        Use my own AI
      </Button>
      <ResponsiveDialog open={ownAiOpen} onOpenChange={setOwnAiOpen}>
        <ResponsiveDialogContent className="sm:max-w-lg">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Use my own AI</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Your agents run on a key, a local model or an AI app.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <OwnAiList
              onSaved={() => setOwnAiOpen(false)}
              slots={{
                renderRuntimeConnect,
                renderOtherService: ({ onSave }) => <DoeInferenceForm onSave={onSave} />,
              }}
            />
          </ResponsiveDialogBody>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}
