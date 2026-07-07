import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NewsletterSubscriber } from '@/db/newsletter-schema';

const { sendMock, upsertContactMock, unsubContactMock, dbState } = vi.hoisted(() => ({
  sendMock: vi.fn().mockResolvedValue(undefined),
  upsertContactMock: vi.fn().mockResolvedValue('contact_1'),
  unsubContactMock: vi.fn().mockResolvedValue(undefined),
  dbState: {
    row: null as NewsletterSubscriber | null,
    inserts: [] as unknown[],
    updates: [] as unknown[],
  },
}));

vi.mock('@/lib/mailer', () => ({ sendNewsletterConfirmation: sendMock }));
vi.mock('@/lib/newsletter/resend-audience', () => ({
  upsertAudienceContact: upsertContactMock,
  unsubscribeAudienceContact: unsubContactMock,
}));
vi.mock('@/lib/auth', () => ({ resolveBaseURL: () => 'https://dorkos.ai' }));
vi.mock('@/db/client', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(dbState.row ? [dbState.row] : []) }),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        dbState.inserts.push(v);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: () => {
          dbState.updates.push(v);
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

import { confirm, subscribe, unsubscribe } from '../service';

function makeRow(over: Partial<NewsletterSubscriber> = {}): NewsletterSubscriber {
  return {
    id: 'row_1',
    email: 'kai@example.com',
    status: 'pending',
    source: 'footer',
    confirmTokenHash: 'hash',
    confirmExpiresAt: new Date(Date.now() + 60_000),
    unsubscribeTokenHash: null,
    resendContactId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    confirmedAt: null,
    unsubscribedAt: null,
    ...over,
  };
}

beforeEach(() => {
  dbState.row = null;
  dbState.inserts = [];
  dbState.updates = [];
  vi.clearAllMocks();
});

describe('subscribe', () => {
  it('inserts a pending row and sends the confirmation for a new address', async () => {
    const outcome = await subscribe('New@Example.com ', 'footer');
    expect(outcome).toBe('created');
    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]).toMatchObject({ email: 'new@example.com', status: 'pending' });
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('rotates the token and resends for an existing pending row', async () => {
    dbState.row = makeRow({ status: 'pending' });
    const outcome = await subscribe('kai@example.com', 'blog');
    expect(outcome).toBe('resent');
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.inserts).toHaveLength(0);
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('is a no-op for an already-confirmed address (no email, no write)', async () => {
    dbState.row = makeRow({ status: 'confirmed' });
    const outcome = await subscribe('kai@example.com', 'footer');
    expect(outcome).toBe('already-confirmed');
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('confirm', () => {
  it('confirms a valid pending token and creates a new Resend contact', async () => {
    dbState.row = makeRow({ status: 'pending', resendContactId: null });
    const result = await confirm('raw-token');
    expect(result).toBe('confirmed');
    expect(upsertContactMock).toHaveBeenCalledWith({ email: 'kai@example.com', contactId: null });
    expect(dbState.updates[0]).toMatchObject({ status: 'confirmed', resendContactId: 'contact_1' });
  });

  it('reactivates the existing contact on a re-subscribe confirm', async () => {
    dbState.row = makeRow({ status: 'pending', resendContactId: 'contact_old' });
    upsertContactMock.mockResolvedValueOnce('contact_old');
    await confirm('raw-token');
    expect(upsertContactMock).toHaveBeenCalledWith({
      email: 'kai@example.com',
      contactId: 'contact_old',
    });
    expect(dbState.updates[0]).toMatchObject({ resendContactId: 'contact_old' });
  });

  it('preserves the existing contact id when the mirror fails (never orphans)', async () => {
    dbState.row = makeRow({ status: 'pending', resendContactId: 'contact_old' });
    upsertContactMock.mockResolvedValueOnce(null);
    expect(await confirm('raw-token')).toBe('confirmed');
    expect(dbState.updates[0]).toMatchObject({ resendContactId: 'contact_old' });
  });

  it('is idempotent for an already-confirmed row', async () => {
    dbState.row = makeRow({ status: 'confirmed' });
    expect(await confirm('raw-token')).toBe('already-confirmed');
    expect(upsertContactMock).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    dbState.row = makeRow({ status: 'pending', confirmExpiresAt: new Date(Date.now() - 1000) });
    expect(await confirm('raw-token')).toBe('invalid');
    expect(dbState.updates).toHaveLength(0);
  });

  it('rejects an unknown token', async () => {
    dbState.row = null;
    expect(await confirm('raw-token')).toBe('invalid');
  });

  it('rejects an empty token without touching the db', async () => {
    expect(await confirm('')).toBe('invalid');
  });
});

describe('unsubscribe', () => {
  it('unsubscribes a confirmed row and suppresses the Resend contact', async () => {
    dbState.row = makeRow({ status: 'confirmed', resendContactId: 'contact_1' });
    const result = await unsubscribe('raw-token');
    expect(result).toBe('unsubscribed');
    expect(unsubContactMock).toHaveBeenCalledWith('contact_1');
    expect(dbState.updates[0]).toMatchObject({ status: 'unsubscribed' });
  });

  it('is idempotent for an already-unsubscribed row', async () => {
    dbState.row = makeRow({ status: 'unsubscribed' });
    expect(await unsubscribe('raw-token')).toBe('already-unsubscribed');
    expect(dbState.updates).toHaveLength(0);
  });

  it('rejects an unknown token', async () => {
    dbState.row = null;
    expect(await unsubscribe('raw-token')).toBe('invalid');
  });
});
