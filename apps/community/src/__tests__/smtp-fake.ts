import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import type { CommunityMailConfig } from '../config.js';

/** What the fake does with the next message: take it, refuse it, defer it, or go silent. */
export type SmtpBehaviour =
  | 'accept'
  | 'reject-recipient'
  | 'defer-recipient'
  | 'silent-after-body'
  | 'silent-once-after-body';

/** One message the fake read to the end of its body. */
export interface ReceivedMail {
  recipients: string[];
  raw: string;
}

/**
 * An in-process SMTP server on loopback, for tests. No real mail leaves it. It records every
 * connection and every message whose body it read, and answers as `behaviour` says. A refusal
 * carries `replyText`, so a test can prove the reply never reaches the database or the logs.
 */
export interface SmtpFake {
  port: number;
  behaviour: SmtpBehaviour;
  replyText: string;
  connections: number;
  received: ReceivedMail[];
  /** A mail config pointing at this fake, sending as `Test Community <notices@community.test>`. */
  mail: CommunityMailConfig;
  /** Wait until `count` messages have been read, or fail after `timeoutMs`. */
  waitForMessages(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Start the fake. It accepts any login, so a URL with credentials works against it. With
 * `offerStartTls` it offers STARTTLS with smtp-server's built-in self-signed certificate, as a
 * local relay often does; otherwise it offers no encryption at all.
 */
export async function startSmtpFake(options: { offerStartTls?: boolean } = {}): Promise<SmtpFake> {
  const held: Array<() => void> = [];
  const fake: SmtpFake = {
    port: 0,
    behaviour: 'accept',
    replyText: 'Rejected',
    connections: 0,
    received: [],
    mail: undefined as unknown as CommunityMailConfig,
    async waitForMessages(count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (fake.received.length < count) {
        if (Date.now() > deadline)
          throw new Error(`SMTP fake received ${fake.received.length} of ${count} messages`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      for (const release of held.splice(0)) release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const reply = (code: number) => Object.assign(new Error(fake.replyText), { responseCode: code });
  const server = new SMTPServer({
    disabledCommands: options.offerStartTls ? [] : ['STARTTLS'],
    authOptional: true,
    allowInsecureAuth: true,
    logger: false,
    onConnect(_session, callback) {
      fake.connections++;
      callback();
    },
    onAuth(_auth, _session, callback) {
      callback(null, { user: 'test' });
    },
    onRcptTo(_address, _session, callback) {
      if (fake.behaviour === 'reject-recipient') return callback(reply(550));
      if (fake.behaviour === 'defer-recipient') return callback(reply(421));
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        fake.received.push({
          recipients: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        if (fake.behaviour === 'silent-once-after-body') fake.behaviour = 'accept';
        else if (fake.behaviour !== 'silent-after-body') return callback();
        // The body arrived; the answer never comes, so the sender times out.
        held.push(() => callback());
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = (server.server.address() as AddressInfo).port;
  fake.mail = {
    smtp: { host: '127.0.0.1', port: fake.port, secure: false, requireTLS: false, auth: null },
    from: { name: 'Test Community', address: 'notices@community.test' },
  };
  return fake;
}
