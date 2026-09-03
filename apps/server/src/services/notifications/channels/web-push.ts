/**
 * The web push channel — how a notification reaches a browser DorkOS is not open
 * in, which for most people means a phone in a pocket (spec
 * `notification-system` task 4.3, ADR 260819-234829).
 *
 * **This is the only channel that can reach somebody who has walked away from
 * the machine.** The in-app surfaces need the tab, the Electron banner needs the
 * desktop, and the relay legs need a chat integration to be set up. A push needs
 * nothing but a browser that once said yes.
 *
 * ## Keys
 *
 * Web push is authenticated with a VAPID keypair, which identifies THIS install
 * to the push services. It is generated on first use and stored at
 * `<dorkHome>/push/vapid.json` with `0600` inside a `0700` directory — the
 * private half is the credential that lets somebody push to every browser
 * subscribed here, so it is treated like one. The path comes from `dorkHome`
 * and never from `os.homedir()` (`.claude/rules/dork-home.md`).
 *
 * ## What a push may say
 *
 * {@link WebPushPayload} and nothing else: a title, a short body, a route, an id
 * and a tier. A push is decrypted by a browser and drawn by the operating
 * system, frequently on a locked screen, so a tool input or a line of transcript
 * put here would be a leak with no way to take it back.
 *
 * ## Dead subscriptions
 *
 * A push service answering `404` or `410` is telling us the browser is gone for
 * good — uninstalled, or the subscription revoked. That row is deleted rather
 * than retried, because a dead endpoint retried on every escalation is a slow
 * request on the path of the one message that matters most.
 *
 * @module services/notifications/channels/web-push
 */
import fs from 'node:fs';
import path from 'node:path';
import webpush, { WebPushError } from 'web-push';
import type { WebPushPayload } from '@dorkos/shared/notification-schemas';
import { publishSecretFile, quarantineSecretFile } from '@dorkos/shared/secret-file';
import { logger } from '../../../lib/logger.js';
import type { PushSubscriptionStore, StoredPushSubscription } from '../push-subscription-store.js';

/**
 * Who the push services should contact about this sender.
 *
 * The VAPID spec wants a `mailto:` or an `https:` URL identifying the
 * application server. A DorkOS install has no address of its own — it is one
 * person's machine — so this names the product, which is both true and the only
 * thing a push service could usefully do anything with.
 */
const VAPID_SUBJECT = 'https://dorkos.ai';

/**
 * How long a push service should hold a message for a browser that is offline.
 *
 * Ten minutes, and deliberately short. This message says "something is waiting
 * on you right now"; a copy delivered when the phone comes back online two hours
 * later is about a condition that has almost certainly resolved, and a
 * notification that is wrong by the time it arrives teaches people to ignore the
 * ones that are not.
 */
const PUSH_TTL_SECONDS = 600;

/** How long to wait on one push service before giving up on that device. */
const PUSH_TIMEOUT_MS = 10_000;

/** The two answers that mean "this browser is gone", rather than "try later". */
const GONE_STATUS_CODES = new Set([404, 410]);

/** Owner-only file mode for the stored keypair (`rw-------`). */
const VAPID_FILE_MODE = 0o600;

/** This install's VAPID keypair. */
interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** What one push attempt did. */
export type PushOutcome =
  | { ok: true; subscriptionId: string }
  | { ok: false; subscriptionId: string; reason: 'gone'; statusCode: number }
  | { ok: false; subscriptionId: string; reason: 'failed'; error: string };

/** What a whole escalation's push leg did, across every subscribed browser. */
export interface PushFanOutResult {
  /** How many browsers took it. */
  delivered: number;
  /** How many rows were dropped because their browser is gone for good. */
  pruned: number;
  /** Every attempt, in the order they were made. */
  outcomes: PushOutcome[];
}

/** The half of the `web-push` library this channel uses, so a test can stand in for it. */
export interface WebPushSender {
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: {
      vapidDetails: { subject: string; publicKey: string; privateKey: string };
      TTL: number;
      timeout: number;
    }
  ): Promise<unknown>;
}

/** What the channel needs wired at boot. */
export interface WebPushChannelDeps {
  /** The data directory, for the keypair. Never resolved from `os.homedir()`. */
  dorkHome: string;
  /** Where subscriptions live, so a dead one can be pruned on the spot. */
  subscriptions: PushSubscriptionStore;
  /** Overridable for tests; defaults to the real `web-push` library. */
  sender?: WebPushSender;
}

/**
 * The web push channel: one keypair, many browsers.
 *
 * Holds no subscription state of its own — {@link PushSubscriptionStore} is the
 * truth, and this reads it per send so a device subscribed a second ago is
 * reached by the next escalation.
 */
export class WebPushChannel {
  private readonly sender: WebPushSender;
  /** Resolved once and then held: reading two files per escalation is pointless. */
  private keys: VapidKeys | null = null;
  /** Set once the keypair proved unavailable, so a broken install fails fast and quietly. */
  private keysUnavailable = false;

  constructor(private readonly deps: WebPushChannelDeps) {
    this.sender = deps.sender ?? webpush;
  }

  /**
   * The public key a browser needs before it can subscribe, or `null` when this
   * install cannot do web push at all.
   *
   * Generating the keypair is a side effect of the first call, which is what
   * makes push cost nothing on an install nobody ever subscribes from.
   */
  publicKey(): string | null {
    return this.resolveKeys()?.publicKey ?? null;
  }

  /** Whether anything could actually be pushed right now. */
  isAvailable(): boolean {
    return this.resolveKeys() !== null && this.deps.subscriptions.all().length > 0;
  }

  /**
   * Send one payload to every subscribed browser.
   *
   * Never throws and never rejects: a push is the last leg of an escalation, and
   * a push service being down must not take the chat leg or the ledger with it.
   * Every browser is attempted, so one dead device cannot silence the rest.
   *
   * @param payload - Exactly what the service worker will draw.
   */
  async sendToAll(payload: WebPushPayload): Promise<PushFanOutResult> {
    const keys = this.resolveKeys();
    if (!keys) return { delivered: 0, pruned: 0, outcomes: [] };

    const subscriptions = this.deps.subscriptions.all();
    if (subscriptions.length === 0) return { delivered: 0, pruned: 0, outcomes: [] };

    const body = JSON.stringify(payload);
    const outcomes = await Promise.all(
      subscriptions.map((subscription) => this.sendOne(subscription, body, keys))
    );

    let delivered = 0;
    let pruned = 0;
    for (const outcome of outcomes) {
      if (outcome.ok) {
        delivered += 1;
        this.deps.subscriptions.touch(outcome.subscriptionId);
        continue;
      }
      if (outcome.reason === 'gone') pruned += 1;
    }
    return { delivered, pruned, outcomes };
  }

  /** Push to one browser, pruning it when the push service says it is gone. */
  private async sendOne(
    subscription: StoredPushSubscription,
    body: string,
    keys: VapidKeys
  ): Promise<PushOutcome> {
    try {
      await this.sender.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        body,
        {
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
          },
          TTL: PUSH_TTL_SECONDS,
          timeout: PUSH_TIMEOUT_MS,
        }
      );
      return { ok: true, subscriptionId: subscription.id };
    } catch (err) {
      const statusCode = statusCodeOf(err);
      if (statusCode !== null && GONE_STATUS_CODES.has(statusCode)) {
        this.deps.subscriptions.removeByEndpoint(subscription.endpoint);
        // Info rather than warn: this is the expected end of a subscription's
        // life, not a problem anybody should act on.
        logger.info('[Push] Dropped a subscription whose browser is gone', {
          id: subscription.id,
          statusCode,
        });
        return { ok: false, subscriptionId: subscription.id, reason: 'gone', statusCode };
      }
      logger.warn('[Push] Could not push to a subscribed browser', {
        id: subscription.id,
        err,
      });
      return {
        ok: false,
        subscriptionId: subscription.id,
        reason: 'failed',
        error: err instanceof Error ? err.message : 'Push failed',
      };
    }
  }

  /**
   * The keypair, reading it from disk or creating it the first time.
   *
   * Answers `null` — rather than throwing — when the file cannot be read OR
   * written. An install on a read-only home directory simply has no push leg,
   * which every caller already handles; failing the escalation outright would
   * lose the chat leg too.
   */
  private resolveKeys(): VapidKeys | null {
    if (this.keys) return this.keys;
    if (this.keysUnavailable) return null;

    try {
      this.keys = readOrCreateVapidKeys(this.deps.dorkHome);
      return this.keys;
    } catch (err) {
      this.keysUnavailable = true;
      logger.warn('[Push] Web push is unavailable: could not read or create the VAPID keys', {
        err,
      });
      return null;
    }
  }
}

/** Where this install's keypair lives. */
export function vapidKeyPath(dorkHome: string): string {
  return path.join(dorkHome, 'push', 'vapid.json');
}

/**
 * Read the VAPID keypair, publishing one on first use.
 *
 * `0600` on the file and `0700` on the directory, because the private key is
 * what authorises a push to every browser subscribed here. A file that exists
 * but does not parse is REPLACED rather than repaired: a half-written keypair
 * authorises nothing, and the cost of a new one is that already-subscribed
 * browsers stop being reachable until they re-subscribe — which the Settings tab
 * shows, and which is strictly better than a permanently dead push leg.
 *
 * The keypair is published first and read second (`@dorkos/shared/secret-file`),
 * never minted after a failed read. Two first boots at once would otherwise both
 * generate, and the loser would go on handing browsers a public key whose
 * private half is no longer on disk — subscriptions that can never be pushed to
 * again, with nothing logged (DOR-712). Replacing an unparseable file goes
 * through the same claim: the file is set aside, then whoever publishes the
 * replacement first wins.
 *
 * @param dorkHome - The data directory.
 * @throws If a keypair can be neither published nor read after setting an
 *   unusable file aside. Reaching that needs a third writer racing both passes;
 *   {@link WebPushChannel.resolveKeys} turns it into a disabled push leg.
 */
export function readOrCreateVapidKeys(dorkHome: string): VapidKeys {
  const file = vapidKeyPath(dorkHome);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  // Two passes at most: claim it, and if what is there cannot be parsed, set it
  // aside and claim again. The idiom is the instance lock's (`lib/instance-lock.ts`).
  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = webpush.generateVAPIDKeys();
    if (publishSecretFile(file, JSON.stringify(generated, null, 2), VAPID_FILE_MODE)) {
      logger.info('[Push] Generated this install’s VAPID keypair', { file });
      return { publicKey: generated.publicKey, privateKey: generated.privateKey };
    }

    const parsed = parseVapidFile(file);
    if (parsed) return parsed;

    const movedTo = quarantineSecretFile(file);
    logger.warn('[Push] The stored VAPID keypair could not be read; set it aside for a new one', {
      file,
      movedTo,
    });
  }

  throw new Error(`Could not establish a VAPID keypair at '${file}'.`);
}

/** Read a stored keypair, or `null` when the file is not one. */
function parseVapidFile(file: string): VapidKeys | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      publicKey?: unknown;
      privateKey?: unknown;
    };
    if (typeof parsed.publicKey !== 'string' || typeof parsed.privateKey !== 'string') return null;
    if (parsed.publicKey === '' || parsed.privateKey === '') return null;
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  } catch {
    return null;
  }
}

/**
 * The HTTP status a failed push came back with, or `null` when the failure was
 * not an answer from a push service at all (a DNS failure, a socket timeout).
 *
 * Duck-typed rather than `instanceof WebPushError` alone: the library is CommonJS
 * and a test's stand-in sender throws its own shape, so the check that matters is
 * whether there is a numeric status code to read.
 */
function statusCodeOf(err: unknown): number | null {
  if (err instanceof WebPushError) return err.statusCode;
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode: unknown }).statusCode;
    if (typeof code === 'number') return code;
  }
  return null;
}
