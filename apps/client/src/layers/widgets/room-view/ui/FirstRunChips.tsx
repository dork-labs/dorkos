import { useCallback } from 'react';
import {
  newPendingId,
  useComposerFocusStore,
  usePostToRoom,
  useRoomDraftStore,
} from '@/layers/entities/room';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { Button, PromptSuggestionChips } from '@/layers/shared/ui';
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
 * With no AI yet, the strip offers the two ways to connect instead. The first
 * run is finished by then, so neither goes back through it: each opens the
 * setup Settings always has — the DorkOS account link, and Runtimes for an AI
 * app, a key or a local model.
 */
export function FirstRunChips({ roomId, mode }: FirstRunChipsProps) {
  const post = usePostToRoom();
  const settings = useSettingsDeepLink();

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
      {/* The first run is over by now, so both open the setup the app always
          has, in Settings over this room: the account link, and the AI apps
          and the DorkOS model. Closing Settings lands back here. */}
      <Button size="sm" variant="outline" onClick={() => settings.open('runtimes')}>
        Use my own AI
      </Button>
    </div>
  );
}
