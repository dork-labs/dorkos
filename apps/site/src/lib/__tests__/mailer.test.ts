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

import {
  sendFeedbackReceipt,
  sendFeedbackShipped,
  sendResetPassword,
  sendVerificationEmail,
} from '../mailer';

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

  describe('sendFeedbackReceipt', () => {
    const trackingUrl = 'https://dorkos.ai/feedback/row-uuid-1';

    it('sends the receipt with the tracking link and the scoped-consent line', async () => {
      await sendFeedbackReceipt(TO, trackingUrl);

      expect(sendMock).toHaveBeenCalledTimes(1);
      const payload = sendMock.mock.calls[0][0] as { to: string; subject: string; html: string };
      expect(payload.to).toBe(TO);
      expect(payload.subject).toBe('We got your DorkOS report');
      expect(payload.html).toContain(trackingUrl);
      expect(payload.html).toMatch(/only email you about this report/i);
    });

    it('never throws when RESEND_API_KEY is unset — catches and logs instead', async () => {
      vi.resetModules();
      vi.doMock('@/env', () => ({ env: { RESEND_FROM: 'DorkOS <accounts@dork.test>' } }));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { sendFeedbackReceipt: sendWithoutKey } = await import('../mailer');

      await expect(sendWithoutKey(TO, trackingUrl)).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[mailer] sendFeedbackReceipt failed',
        expect.objectContaining({ message: expect.stringContaining('RESEND_API_KEY') })
      );

      consoleErrorSpy.mockRestore();
      vi.doUnmock('@/env');
    });
  });

  describe('sendFeedbackShipped', () => {
    it('sends the shipped email quoting the report and naming the version', async () => {
      await sendFeedbackShipped(TO, {
        message: 'Chat stopped updating after the stream dropped.\nMore detail here.',
        shippedVersion: '0.56.3',
      });

      expect(sendMock).toHaveBeenCalledTimes(1);
      const payload = sendMock.mock.calls[0][0] as { to: string; subject: string; html: string };
      expect(payload.to).toBe(TO);
      expect(payload.subject).toBe('Your DorkOS report shipped in v0.56.3');
      expect(payload.html).toContain('Chat stopped updating after the stream dropped.');
      expect(payload.html).not.toContain('More detail here.');
      expect(payload.html).toMatch(/only email you about this report/i);
    });

    it('includes the changelog link only when one is provided', async () => {
      await sendFeedbackShipped(TO, {
        message: 'Add dark mode',
        shippedVersion: '0.56.3',
        changelogUrl: 'https://dorkos.ai/blog/dorkos-0-56-3',
      });
      const withLink = sendMock.mock.calls[0][0] as { html: string };
      expect(withLink.html).toContain('https://dorkos.ai/blog/dorkos-0-56-3');

      sendMock.mockClear();
      await sendFeedbackShipped(TO, { message: 'Add dark mode', shippedVersion: '0.56.3' });
      const withoutLink = sendMock.mock.calls[0][0] as { html: string };
      expect(withoutLink.html).not.toContain('<a href');
    });

    it('never throws on a Resend send failure — catches and logs instead', async () => {
      sendMock.mockRejectedValueOnce(new Error('resend outage'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        sendFeedbackShipped(TO, { message: 'Add dark mode', shippedVersion: '0.56.3' })
      ).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[mailer] sendFeedbackShipped failed',
        expect.objectContaining({ message: 'resend outage' })
      );

      consoleErrorSpy.mockRestore();
    });

    it('renders a non-version shippedVersion (a Linear milestone/cycle name) without a "v" prefix', async () => {
      await sendFeedbackShipped(TO, { message: 'Add dark mode', shippedVersion: 'Cycle 12' });

      const payload = sendMock.mock.calls[0][0] as { subject: string; html: string };
      expect(payload.subject).toBe('Your DorkOS report shipped in Cycle 12');
      expect(payload.html).toContain('Good news: this shipped in Cycle 12.');
      expect(payload.subject).not.toContain('vCycle');
      expect(payload.html).not.toContain('vCycle');
    });
  });
});
