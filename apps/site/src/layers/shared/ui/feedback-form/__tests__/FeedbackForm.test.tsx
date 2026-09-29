import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/analytics', () => ({ getAnalyticsDistinctId: () => undefined }));
import { FeedbackForm } from '../FeedbackForm';

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('FeedbackForm shared controls', () => {
  // The primitive defaults to a non-submit button; the form must explicitly submit.
  it('submits the existing payload and disables duplicate sends while pending', async () => {
    let finish!: (response: { ok: boolean }) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve as typeof finish;
        })
    );
    render(<FeedbackForm />);
    fireEvent.change(screen.getByLabelText('Your message'), {
      target: { value: 'Keep this message' },
    });
    fireEvent.change(screen.getByLabelText('Contact (optional)'), {
      target: { value: 'reader@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.events[0]).toMatchObject({
      event: 'feedback_submitted',
      properties: { message: 'Keep this message', contact: 'reader@example.com', surface: 'site' },
    });
    finish({ ok: true });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Thanks, sent.'));
  });

  it('preserves the message and exposes an error before a successful retry', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    render(<FeedbackForm />);
    const message = screen.getByLabelText('Your message') as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: 'Retry this message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    expect(message.value).toBe('Retry this message');
    expect(message.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('status');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
