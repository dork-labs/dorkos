/**
 * Say where a user message came from when nobody in the chat typed it, at the
 * same wire boundary chat and room stamps are put on (DOR-3019).
 *
 * A schedule's prompt reaches the transcript as plain text, so the words alone
 * can't say who sent them. The server knows which schedules ran in this chat,
 * so a message is a schedule's when it is that schedule's prompt. A prompt
 * edited since an old run no longer matches, and that run's message keeps
 * reading as the person's. A heartbeat opens with one fixed sentence.
 *
 * @module services/session/chat-messages/prompt-source
 */
import { HEARTBEAT_PROMPT_OPENING, type PromptSource } from '@dorkos/shared/chat-messages';

/** One schedule that ran in a chat. */
export interface ScheduledPrompt {
  /** The schedule's prompt. */
  prompt: string;
  /** The schedule's name as people see it. */
  name: string;
}

/** The schedules that ran in a chat, by every id the chat answers to. */
export type ScheduledPromptLookup = (sessionIds: readonly string[]) => ScheduledPrompt[];

let lookup: ScheduledPromptLookup | undefined;

/**
 * Wire the tasks domain's lookup. Called once at startup; `undefined` unwires it.
 *
 * @param next - The lookup.
 */
export function setScheduledPromptLookup(next: ScheduledPromptLookup | undefined): void {
  lookup = next;
}

/**
 * Build a reader for one chat's messages. The schedules are read at most once,
 * and only when a message needs them.
 *
 * @param sessionIds - Every id the chat answers to.
 * @param look - The lookup; the wired one when omitted.
 * @returns Where a message's words came from, or null when a person's they may be.
 */
export function promptSourceReader(
  sessionIds: readonly string[],
  look: ScheduledPromptLookup | undefined = lookup
): (content: string) => PromptSource | null {
  let prompts: Map<string, string> | undefined;
  return (content) => {
    if (content.trimStart().startsWith(HEARTBEAT_PROMPT_OPENING)) return { kind: 'heartbeat' };
    prompts ??= new Map(
      (look?.(sessionIds) ?? []).map(({ prompt, name }) => [prompt.trim(), name])
    );
    const name = prompts.get(content.trim());
    return name === undefined ? null : { kind: 'schedule', label: name };
  };
}
