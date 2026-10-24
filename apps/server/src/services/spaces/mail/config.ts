import { z } from 'zod';

/** Where and how the Community hands mail to the host's own SMTP server. */
export type CommunityMailConfig = {
  smtp: {
    host: string;
    port: number;
    /** Implicit TLS from the first byte (`smtps:`). */
    secure: boolean;
    /** Refuse to send unless the server upgrades the connection with STARTTLS. */
    requireTLS: boolean;
    auth: { user: string; pass: string } | null;
  };
  /** The sender every notice carries, from `COMMUNITY_MAIL_FROM`. */
  from: { name: string | null; address: string };
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
const EMAIL = z.email();

/**
 * Read the one RFC 5322 mailbox notices come from: `notices@example.com` or
 * `Example Community <notices@example.com>`. A line break, a second address, or a group is
 * refused, so the setting can never add a header.
 */
function parseMailFrom(value: string): CommunityMailConfig['from'] {
  const invalid = () =>
    new Error(
      'COMMUNITY_MAIL_FROM must be one mailbox, such as notices@example.com or Example <notices@example.com>'
    );
  if (/[\p{Cc}]/u.test(value)) throw invalid();
  const named = /^\s*(?:"([^"\\]{1,80})"|([^"<>,;:@\\]{1,80}?))\s*<([^<>\s]+)>\s*$/u.exec(value);
  const address = named ? named[3] : value.trim();
  if (!EMAIL.safeParse(address).success) throw invalid();
  const name = named ? (named[1] ?? named[2]).trim() : '';
  return { name: name || null, address };
}

/**
 * Read the mail settings: `COMMUNITY_SMTP_URL` and `COMMUNITY_MAIL_FROM` together, or neither.
 * Off loopback the connection must be encrypted: `smtps://` (TLS from the start), or `smtp://`
 * with `?starttls=required`. Credentials, if any, go in the URL and are percent-decoded.
 */
export function parseMail(value: {
  COMMUNITY_SMTP_URL?: string;
  COMMUNITY_MAIL_FROM?: string;
}): CommunityMailConfig | null {
  const { COMMUNITY_SMTP_URL: smtpUrl, COMMUNITY_MAIL_FROM: mailFrom } = value;
  if (!smtpUrl && !mailFrom) return null;
  if (!smtpUrl || !mailFrom)
    throw new Error('COMMUNITY_SMTP_URL and COMMUNITY_MAIL_FROM must be set together');
  const shape = 'COMMUNITY_SMTP_URL must be smtps://host[:port] or smtp://host[:port]';
  let url: URL;
  try {
    url = new URL(smtpUrl);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Node's URL error carries the input, password and all.
    throw new Error(shape);
  }
  if ((url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || !url.hostname)
    throw new Error(shape);
  if ((url.pathname !== '' && url.pathname !== '/') || url.hash)
    throw new Error(`${shape}, with no path or fragment`);
  const query = [...url.searchParams.entries()];
  const starttls = query.length === 1 && query[0][0] === 'starttls' && query[0][1] === 'required';
  if (query.length && (!starttls || url.protocol !== 'smtp:'))
    throw new Error('COMMUNITY_SMTP_URL takes one option only: ?starttls=required on smtp://');
  const secure = url.protocol === 'smtps:';
  if (url.port === '0') throw new Error('COMMUNITY_SMTP_URL must not use port 0');
  const plain = !secure && !starttls;
  // For an unencrypted relay `localhost` means the IPv4 loopback address, never whatever a
  // resolver answers for it, so the no-encryption exemption can only ever reach this machine.
  const lowered = url.hostname.toLowerCase();
  const hostname = plain && lowered === 'localhost' ? '127.0.0.1' : lowered;
  if (plain && !LOOPBACK_HOSTS.has(hostname))
    throw new Error(
      'COMMUNITY_SMTP_URL must encrypt mail off this machine: use smtps://, or smtp:// with ?starttls=required'
    );
  if (Boolean(url.username) !== Boolean(url.password))
    throw new Error('COMMUNITY_SMTP_URL must carry both a user name and a password, or neither');
  let auth: CommunityMailConfig['smtp']['auth'] = null;
  if (url.username) {
    try {
      auth = { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) };
    } catch {
      // eslint-disable-next-line preserve-caught-error -- the cause would name the encoded password.
      throw new Error('COMMUNITY_SMTP_URL has a badly encoded user name or password');
    }
  }
  return {
    smtp: {
      host: hostname.replace(/^\[(.*)\]$/u, '$1'),
      port: url.port ? Number(url.port) : secure ? 465 : starttls ? 587 : 25,
      secure,
      requireTLS: starttls,
      auth,
    },
    from: parseMailFrom(mailFrom),
  };
}
