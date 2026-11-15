/** Whether the agent behind a chat may use a named Agent browser profile. */
import { LocalBrowserError } from './errors.js';
import type { LocalBrowserProfileStore } from './profile-store.js';

/** The verified launch facts this check reads; it never reads an agent's own files. */
export interface LocalBrowserProfileAccessDeps {
  profiles: Pick<LocalBrowserProfileStore, 'isBound'>;
  resolveSessionRuntime(sessionId: string): Promise<{ type: string; bound: boolean }>;
  getSessionAgentPath(sessionId: string): Promise<string | null>;
  agentIdAtPath(agentPath: string): string | undefined;
  /** The folder's real path, or undefined when it can't be read. */
  realFolder(agentPath: string): string | undefined;
}

/** Answers once per tool call. A refusal throws, so nothing is allowed by accident. */
export type LocalBrowserProfileAccess = (profileId: string, sessionId: string) => Promise<void>;

/** The most of the holding chat's title a refusal elsewhere quotes. */
export const MAX_HOLDER_TITLE = 60;

/**
 * The holding chat's title as another chat's agent hears it: control and direction
 * characters stripped, cut to {@link MAX_HOLDER_TITLE}. Never its id or its content.
 *
 * @param title - The chat's raw title, if known.
 */
export function holderTitle(title: string | null | undefined): string | null {
  const whole = title
    ?.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!whole) return null;
  const characters = Array.from(whole);
  return characters.length > MAX_HOLDER_TITLE
    ? `${characters.slice(0, MAX_HOLDER_TITLE).join('')}…`
    : whole;
}

/** Admission facts for the selected profile; no profile data is read here. */
export class BrowserProfileAccessGate {
  exists?: (id: string) => boolean;
  private access?: LocalBrowserProfileAccess;
  // None until startup wires chat titles; a refusal elsewhere then says "another chat".
  private titleOf: (sessionId: string) => Promise<string | null> = async () => null;
  private holder: { sessionId: string; title: string | null } | null = null;
  // The chat a person last moved the browser away from, told so rather than just refused.
  private movedFrom: string | null = null;

  use(
    access: LocalBrowserProfileAccess,
    exists: (id: string) => boolean,
    titleOf?: (sessionId: string) => Promise<string | null>
  ): void {
    this.access = access;
    this.exists = exists;
    if (titleOf) this.titleOf = titleOf;
  }

  /**
   * Remember the opening chat's title, so a refusal elsewhere can name it without a
   * wait, and which chat it moved from, so that chat's agent hears it was moved.
   *
   * @param sessionId - The chat it opens for, or null for the person alone.
   * @param previous - The chat that held it, still open, until this open.
   */
  async rememberHolder(sessionId: string | null, previous: string | null): Promise<void> {
    this.movedFrom = sessionId && previous && previous !== sessionId ? previous : null;
    if (!sessionId) return void (this.holder = null);
    const title = holderTitle(await this.titleOf(sessionId).catch(() => null));
    this.holder = { sessionId, title };
  }

  /**
   * Not opened and opened for another chat are different asks of the person (DOR-4265),
   * so the agent hears which one, with the other chat in its own fields.
   */
  requireShared(selected: string | null, sessionId: string): void {
    if (selected === sessionId) return;
    if (selected === null)
      throw new LocalBrowserError(
        'not_opened',
        'The Agent browser isn’t open yet. Ask the person to open it. In a room, they open it from a direct chat with you.'
      );
    // The title is text a person or agent wrote, so it rides in its own field.
    const chatTitle = this.holder?.sessionId === selected ? this.holder.title : null;
    throw new LocalBrowserError(
      'shared_elsewhere',
      this.movedFrom === sessionId
        ? 'The person moved the Agent browser to another chat, named in chatTitle. Ask them to move it back if you still need it.'
        : 'The Agent browser is in use in another chat, named in chatTitle. Ask the person to move it here.',
      { chatId: selected, chatTitle }
    );
  }

  async require(profileId: string | null, sessionId: string): Promise<void> {
    if (!profileId) return;
    if (!this.access)
      throw new LocalBrowserError('profile_not_allowed', 'This agent can’t use this profile.');
    await this.access(profileId, sessionId);
  }
}

/**
 * Build the check run before and after every agent tool call on a named profile.
 *
 * @param deps - The profile records and the session's launch facts.
 */
export function createLocalBrowserProfileAccess(
  deps: LocalBrowserProfileAccessDeps
): LocalBrowserProfileAccess {
  return async (profileId, sessionId) => {
    const runtime = await deps.resolveSessionRuntime(sessionId);
    // Codex and OpenCode don't honour the deny on the profiles folder yet.
    if (!runtime.bound || runtime.type !== 'claude-code')
      throw new LocalBrowserError(
        'profile_runtime',
        'Named browser profiles aren’t available for Codex or OpenCode agents yet.'
      );
    const agentPath = await deps.getSessionAgentPath(sessionId);
    const agentId = agentPath ? deps.agentIdAtPath(agentPath) : undefined;
    const folder = agentPath ? deps.realFolder(agentPath) : undefined;
    if (!agentId || !folder || !deps.profiles.isBound(profileId, agentId, folder))
      throw new LocalBrowserError(
        'profile_not_allowed',
        'This agent can’t use this browser profile. A person can add it.'
      );
  };
}
