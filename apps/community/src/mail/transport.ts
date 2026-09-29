import nodemailer from 'nodemailer';
import type { CommunityMailConfig } from '../config.js';

/** One plain-text message to one address. */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * What the host's mail server did with one message. `accepted` means only that the server
 * answered `2xx` for the whole message; the product never claims more. `refused` is a permanent
 * `5xx` answer. `retrying` is everything else: `SMTP_TLS` when the encrypted connection could not
 * be made (including a server that does not offer the required STARTTLS), `SMTP_AUTH` when the
 * login was refused, and `SMTP_UNAVAILABLE` for a temporary answer, a timeout, or no connection.
 * TLS and login failures are the host's own settings to fix, so they are retried like an outage
 * but reported under their own codes, where a host watching its logs can tell them apart.
 */
export type MailDelivery =
  | { outcome: 'accepted' }
  | { outcome: 'refused'; errorClass: 'SMTP_REJECTED' }
  | { outcome: 'retrying'; errorClass: 'SMTP_TLS' | 'SMTP_AUTH' | 'SMTP_UNAVAILABLE' };

/** Hands messages to the host's mail server. */
export interface MailTransport {
  /** Send one message. Never rejects: every failure is classified, never passed on raw. */
  send(message: OutgoingMail): Promise<MailDelivery>;
}

/** How long each SMTP step may wait before the attempt counts as a timeout. */
export interface SmtpTimeouts {
  connectionMs: number;
  greetingMs: number;
  /** Silence allowed on an open connection, including after the message body. */
  socketMs: number;
}

/**
 * The defaults. nodemailer applies each one per step, so they do not bound a whole attempt; the
 * worker's own attempt cap does that, inside the message's lease.
 */
export const SMTP_TIMEOUTS: SmtpTimeouts = {
  connectionMs: 30_000,
  greetingMs: 30_000,
  socketMs: 60_000,
};

/**
 * Classify a failed send from its SMTP reply code and nodemailer's error code alone. The reply
 * text is never read: it can echo the recipient's address. A `5xx` answer to the envelope or the
 * message is permanent. Every other failure is retried (see {@link MailDelivery}).
 */
export function classifySmtpFailure(error: unknown): MailDelivery {
  const reply =
    typeof error === 'object' && error !== null
      ? (error as { responseCode?: unknown; code?: unknown })
      : {};
  const permanent =
    typeof reply.responseCode === 'number' &&
    reply.responseCode >= 500 &&
    reply.responseCode < 600 &&
    (reply.code === 'EENVELOPE' || reply.code === 'EMESSAGE');
  if (permanent) return { outcome: 'refused', errorClass: 'SMTP_REJECTED' };
  if (reply.code === 'ETLS') return { outcome: 'retrying', errorClass: 'SMTP_TLS' };
  if (reply.code === 'EAUTH') return { outcome: 'retrying', errorClass: 'SMTP_AUTH' };
  return { outcome: 'retrying', errorClass: 'SMTP_UNAVAILABLE' };
}

/**
 * Send through the host's SMTP server with nodemailer. One connection per message, closed after
 * it (no pool), so nothing stays open between the worker's rare sends. Plain text only;
 * nodemailer may not read files or fetch URLs on a message's behalf, and it logs nothing.
 */
export function createSmtpTransport(
  config: CommunityMailConfig,
  timeouts: SmtpTimeouts = SMTP_TIMEOUTS
): MailTransport {
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: config.smtp.requireTLS,
    // A plain relay on this machine (the only place config allows no encryption) is used as is.
    // Otherwise nodemailer would try STARTTLS whenever the relay offers it, and a local relay's
    // self-signed certificate would then fail every send.
    ignoreTLS: !config.smtp.secure && !config.smtp.requireTLS,
    ...(config.smtp.auth ? { auth: config.smtp.auth } : {}),
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  const from = config.from.name
    ? { name: config.from.name, address: config.from.address }
    : config.from.address;
  return {
    async send(message) {
      try {
        await transporter.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
        return { outcome: 'accepted' };
      } catch (error) {
        return classifySmtpFailure(error);
      }
    },
  };
}
