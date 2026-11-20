import { BrowserProfileAccessGate } from '../profile-access.js';
import { LocalBrowserError } from '../errors.js';

/** Immutable birth identity and revocation survive person custody changes. */
export class BrowserLeaseAuthority {
  readonly profiles = new BrowserProfileAccessGate();
  agentId?: string;
  private chat: string | null = null;
  private profile: string | null = null;
  private generation = 0;
  private revoked = false;
  private proof?: () => void;

  constructor(
    private readonly lookup: () => Promise<string | undefined>,
    private readonly onRevoked: () => void
  ) {}

  async begin(chat: string | null, profile: string | null): Promise<void> {
    const generation = ++this.generation;
    this.chat = chat;
    this.profile = profile;
    this.revoked = false;
    this.agentId = undefined;
    this.proof = undefined;
    const agent = chat ? await this.lookup() : undefined;
    if (generation !== this.generation) throw denied();
    this.agentId = agent;
    if (chat && profile) this.proof = this.profiles.capture(profile, chat, agent);
    this.assertCurrent();
  }

  get isRevoked(): boolean {
    return this.revoked;
  }

  matches(profile: string, agent?: string): boolean {
    return this.profile === profile && (!agent || !this.agentId || this.agentId === agent);
  }

  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    this.generation++;
    this.onRevoked();
  }

  assertCurrent(audience: 'agent' | 'person' = 'agent'): void {
    if (this.revoked) throw denied(audience);
    try {
      this.proof?.();
    } catch (error) {
      this.revoke();
      if (
        audience === 'person' &&
        error instanceof LocalBrowserError &&
        error.code === 'profile_not_allowed'
      )
        throw denied(audience);
      throw error;
    }
  }

  async require(chat: string): Promise<void> {
    this.assertCurrent();
    if (this.chat && this.chat !== chat) throw denied();
    await this.profiles.require(this.profile, chat);
    this.assertCurrent();
  }
}

function denied(audience: 'agent' | 'person' = 'agent'): LocalBrowserError {
  return new LocalBrowserError(
    'profile_not_allowed',
    audience === 'person'
      ? 'This browser is unavailable. Open it again.'
      : 'This browser is unavailable. Ask the person to open it again.'
  );
}
