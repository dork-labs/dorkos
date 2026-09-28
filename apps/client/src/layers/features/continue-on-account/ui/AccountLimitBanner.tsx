import { useId, useState, type ReactNode } from 'react';
import { ACCOUNT_RESUME_PROMPT } from '@dorkos/shared/account-usage';
import { AccountDot, Banner, Button } from '@/layers/shared/ui';
import { formatResetTime, modelBucketName } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import {
  bannerActions,
  bannerVariantFor,
  hasPassed,
  shouldHaveResetSentence,
  isCarryOverRefused,
  outOfUsageSentence,
  PRIMARY_ACTIONS,
  secondsUntil,
  waitingSentence,
  waitTargetOf,
  type LimitBannerAction,
} from '../lib/limit-banner';
import { modelDisplayName } from '../lib/limit-marker';
import type { NamedAccount } from '../model/use-account-namer';
import { useLimitBanner, type LimitBannerAccount } from '../model/use-limit-banner';
import { ContinueOnAccountDialog } from './ContinueOnAccountDialog';

/** Props for {@link AccountLimitBanner}. */
export interface AccountLimitBannerProps {
  /** The session whose limit the banner shows. */
  sessionId: string;
  /**
   * Send a message as the person, through the conversation's normal send
   * path. `reset-ready`'s Continue sends the resume message with it, which
   * clears the limit.
   */
  onSend: (text: string) => void;
  /**
   * The session's account, handed in instead of read from the session (the
   * Dev Playground). Omit in the app.
   */
  account?: LimitBannerAccount;
  /** A fixed moment to read from (tests and the Dev Playground); else the clock. */
  now?: Date;
}

/**
 * A sentence whose visible words tick (a countdown, a duration) but whose
 * spoken words are set once per `spokenKey`, so a screen reader in the
 * banner's live region is not read a new number every second or minute.
 */
function TickingText({
  visible,
  spoken,
  spokenKey,
}: {
  visible: ReactNode;
  spoken: string;
  spokenKey: string;
}) {
  const [said, setSaid] = useState({ key: spokenKey, text: spoken });
  // Derived from the key during render (React's documented pattern), so the
  // spoken sentence changes exactly when the state it describes changes.
  if (said.key !== spokenKey) setSaid({ key: spokenKey, text: spoken });
  return (
    <>
      <span aria-hidden>{visible}</span>
      <span className="sr-only">{said.key === spokenKey ? said.text : spoken}</span>
    </>
  );
}

/** Another account's dot and name inside a sentence; the name is printed, so the dot is not read. */
function Named({ account, showDot }: { account: NamedAccount; showDot: boolean }) {
  return (
    <>
      {showDot && account.color && (
        <span aria-hidden className="mr-1 inline-flex align-middle">
          <AccountDot color={account.color} name={account.name} tooltip={false} />
        </span>
      )}
      {account.name}
    </>
  );
}

/** The words each button says. */
function actionLabel(action: LimitBannerAction, fallbackModel: string | null): string {
  switch (action) {
    case 'continue-on':
      return 'Continue on another account…';
    case 'move-now':
      return 'Move now';
    case 'choose':
      return 'Choose account…';
    case 'keep-going':
      return `Keep going on ${fallbackModel}, same account`;
    case 'resume':
      return 'Continue';
    case 'open-moved':
      return 'Open it →';
    case 'continue-here':
      return 'Continue here anyway';
    case 'wait':
      return 'Wait for reset';
  }
}

/**
 * The out-of-usage banner (spec `claude-account-ui` §6.7, decision option A):
 * above the message box while a session's account (or one model on it) is
 * out, it says who ran out, until when, and what the person can do. One
 * layout for every state: a bold first sentence, an optional second one, a
 * row of buttons and, while waiting, a checkbox. When the episode resolves the
 * banner goes away and the transcript's marker says what happened.
 *
 * Red while an account is out and needs the person, neutral grey once they
 * chose to wait, the reset is ready, or the work moved (Q13), the same split
 * the sidebar row and header badge follow. It follows the session's limit
 * for every runtime and any number of accounts (invariant 5): a Codex session
 * reads "Codex is out of usage…" and can only wait.
 *
 * `role="status"` in every state: the turn's error already announced the
 * stop. Countdown digits are hidden from screen readers beside a sentence set
 * once per state. Makes no usage request.
 */
export function AccountLimitBanner({
  sessionId,
  onSend,
  account: injected,
  now: fixedNow,
}: AccountLimitBannerProps) {
  const banner = useLimitBanner(sessionId, injected);
  const { limit, state, subject, identityGate } = banner;
  // Seconds only while a move counts down; minutes otherwise. One interval.
  const tick = useNow(state === 'handing-off' ? 1000 : 60_000);
  const now = fixedNow ?? new Date(tick);
  // The picker belongs to the episode it was opened in: a new episode never
  // finds it open (and never cancels a move unasked), and a state that stops
  // offering it (moved) closes it through `canPick`. Not keyed by the state:
  // "Choose account…" itself cancels the move, which turns handing-off into
  // limited in the same episode, and the picker must stay open through that.
  const pickerKey = limit ? limit.since : null;
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const pickerOpen = banner.canPick && pickerKey !== null && pickerFor === pickerKey;
  const setPickerOpen = (open: boolean) => setPickerFor(open ? pickerKey : null);
  const checkboxId = useId();

  if (!limit || !state) return null;

  const plan = limit.plan;
  const fallbackModel = modelDisplayName(limit.modelFallback, banner.models);
  const actions = bannerActions(state, {
    canPick: banner.canPick,
    hasFallback: fallbackModel !== null,
    continuedHere: banner.continuedHere,
  });
  // A spoken sentence is set again only when what it says changes: the state,
  // the episode, or a name that has just resolved.
  const episode = `${state}:${limit.since}:${subject}`;

  let headline: ReactNode;
  let detail: ReactNode = null;
  let movePassed = false;
  switch (state) {
    case 'all-accounts-out': {
      headline = 'All accounts are out.';
      const soonest = limit.allOut;
      if (soonest?.resetsAt) {
        const back = banner.nameOf(soonest.accountId);
        // A time already past reads as Q12's words, never as a past time.
        detail = hasPassed(soonest.resetsAt, now) ? (
          shouldHaveResetSentence(back.name)
        ) : (
          <>
            Soonest back: <Named account={back} showDot={identityGate} />,{' '}
            {formatResetTime(soonest.resetsAt, now)}
          </>
        );
      }
      break;
    }
    case 'model-limited':
      headline = `${modelBucketName(limit.window, banner.models)} is out on ${subject} for this week.`;
      break;
    case 'waiting-reset': {
      const target = waitTargetOf(limit);
      headline = (
        <TickingText
          visible={waitingSentence(subject, target, now)}
          spoken={waitingSentence(subject, target, now)}
          spokenKey={`${episode}:${hasPassed(target, now)}`}
        />
      );
      break;
    }
    case 'reset-ready':
      headline =
        plan.mode === 'waiting' && plan.unconfirmed
          ? `${subject} should have reset by now.`
          : `${subject} has reset.`;
      break;
    case 'moved': {
      // S4 reports `moved` only with the `continued` plan that names where.
      if (plan.mode !== 'continued') return null;
      const moved = banner.nameOf(plan.accountId);
      headline = (
        <>
          This task continued on <Named account={moved} showDot={identityGate} />.
        </>
      );
      break;
    }
    default: {
      const sentence = outOfUsageSentence(subject, limit.window, limit.resetsAt, now);
      headline = (
        <TickingText
          visible={sentence}
          spoken={sentence}
          spokenKey={`${episode}:${hasPassed(limit.resetsAt, now)}`}
        />
      );
      if (state === 'handing-off' && plan.mode === 'auto') {
        const target = banner.nameOf(plan.target);
        const seconds = secondsUntil(plan.fireAt, now);
        movePassed = seconds === 0;
        detail = (
          <TickingText
            visible={
              <>
                Moving this task to <Named account={target} showDot={identityGate} />
                {movePassed ? '…' : ` in ${seconds}s…`}
              </>
            }
            spoken={
              movePassed
                ? `Moving this task to ${target.name}.`
                : `Moving this task to ${target.name} in ${seconds} seconds.`
            }
            spokenKey={`${episode}:${plan.fireAt}:${target.name}:${movePassed}`}
          />
        );
      }
    }
  }

  const run = (action: LimitBannerAction) => {
    switch (action) {
      case 'continue-on':
      case 'choose':
        setPickerOpen(true);
        return;
      case 'move-now':
        if (plan.mode === 'auto') banner.continueOn({ account: plan.target });
        return;
      case 'keep-going':
        if (limit.modelFallback) banner.continueOn({ model: limit.modelFallback });
        return;
      case 'resume':
        onSend(ACCOUNT_RESUME_PROMPT);
        return;
      case 'open-moved':
        if (plan.mode === 'continued') banner.openSession(plan.sessionId);
        return;
      case 'continue-here':
        banner.continueHere();
        return;
      case 'wait':
        banner.wait();
        return;
    }
  };

  // The checkbox shows the STORED choice, never what was asked for: a runtime
  // core cannot resume stores `false` whatever the request said, and a
  // session that can only wait has no automatic resume at all.
  const showCheckbox =
    state === 'waiting-reset' && plan.mode === 'waiting' && !isCarryOverRefused(plan);

  return (
    <>
      <Banner
        variant={bannerVariantFor(state)}
        role="status"
        icon={null}
        data-slot="account-limit-banner"
        data-state={state}
        className="mx-4 mb-2 rounded-lg border px-3 py-2"
      >
        <p>
          <strong className="font-semibold">{headline}</strong>
          {detail && <> {detail}</>}
        </p>
        {showCheckbox && (
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id={checkboxId}
              type="checkbox"
              className="size-3.5"
              checked={plan.autoResume}
              disabled={banner.pending}
              onChange={(event) => banner.wait(event.target.checked)}
            />
            <label htmlFor={checkboxId}>Continue automatically when it resets</label>
          </div>
        )}
        {actions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <Button
                key={action}
                size="sm"
                variant={
                  PRIMARY_ACTIONS.has(action)
                    ? 'default'
                    : action === 'continue-here'
                      ? 'ghost'
                      : 'outline'
                }
                // A long model name may not fit a phone's row: the label wraps
                // inside the button rather than running out of the banner.
                className="h-auto min-h-11 max-w-full py-1 whitespace-normal md:min-h-8"
                disabled={banner.pending || (action === 'move-now' && movePassed)}
                onClick={() => run(action)}
              >
                {actionLabel(action, fallbackModel)}
              </Button>
            ))}
          </div>
        )}
        {banner.failure && (
          <p role="alert" className="text-destructive mt-1.5">
            {banner.failure}
          </p>
        )}
      </Banner>
      {banner.canPick && (
        <ContinueOnAccountDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          sessionId={sessionId}
          account={{
            runtime: banner.runtime,
            accountId: banner.account.accountId,
            limit,
            trackerItem: banner.account.trackerItem,
          }}
          cancelAutoFirst={state === 'handing-off'}
          now={fixedNow}
        />
      )}
    </>
  );
}
