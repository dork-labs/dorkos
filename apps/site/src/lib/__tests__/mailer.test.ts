/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Resend SDK at the module boundary — no real network I/O ever happens.
// `vi.hoisted` runs before the hoisted `vi.mock` factory, so the mocks exist
// when the factory references them.
const { sendMock, ResendMock } = vi.hoisted(() => {
  const send = vi.fn().mockResolvedValue({ data: { id: 'email_test' }, error: null });
  // Vitest 4 spies honor `new` semantics, so the implementation must be
  // constructible — an arrow function here throws "is not a constructor".
  const Resend = vi.fn().mockImplementation(function () {
    return { emails: { send } };
  });
  return { sendMock: send, ResendMock: Resend };
});
vi.mock('resend', () => ({ Resend: ResendMock }));

// Deterministic env so the mailer has an API key and a known From address.
vi.mock('@/env', () => ({
  env: {
    RESEND_API_KEY: 'test_api_key',
    RESEND_FROM: 'DorkOS <accounts@dork.test>',
  },
}));

import { sendResetPassword, sendVerificationEmail } from '../mailer';

const TO = 'kai' + '@' + 'dork.test';
const URL = 'https://dorkos.ai/api/auth/verify?token=abc123';

describe('mailer (Resend seam)', () => {
  beforeEach(() => {
    sendMock.mockClear();
    ResendMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends a verification email with DorkOS-account copy and the token URL', async () => {
    await sendVerificationEmail({ to: TO, url: URL });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as {
      from: string;
      to: string;
      subject: string;
      html: string;
    };
    expect(payload.from).toBe('DorkOS <accounts@dork.test>');
    expect(payload.to).toBe(TO);
    expect(payload.subject).toMatch(/verify your DorkOS account/i);
    expect(payload.html).toContain(URL);
    // Product naming: "DorkOS account", never "DorkOS Cloud account".
    expect(payload.subject).not.toMatch(/cloud account/i);
    expect(payload.html).not.toMatch(/cloud account/i);
  });

  it('sends a password-reset email with DorkOS-account copy and the token URL', async () => {
    const resetUrl = 'https://dorkos.ai/api/auth/reset?token=xyz789';
    await sendResetPassword({ to: TO, url: resetUrl });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as { subject: string; html: string; to: string };
    expect(payload.to).toBe(TO);
    expect(payload.subject).toMatch(/reset your DorkOS account password/i);
    expect(payload.html).toContain(resetUrl);
    expect(payload.subject).not.toMatch(/cloud account/i);
  });

  it('throws a clear error when RESEND_API_KEY is not configured', async () => {
    vi.resetModules();
    vi.doMock('@/env', () => ({ env: { RESEND_FROM: 'DorkOS <accounts@dork.test>' } }));
    const { sendVerificationEmail: sendWithoutKey } = await import('../mailer');

    await expect(sendWithoutKey({ to: TO, url: URL })).rejects.toThrow(/RESEND_API_KEY/);
    vi.doUnmock('@/env');
  });
});
