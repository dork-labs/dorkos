import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock('posthog-js', () => ({ default: { capture: captureMock } }));

import { NewsletterSignupForm } from '../NewsletterSignupForm';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

describe('NewsletterSignupForm', () => {
  it('renders the cadence promise and a subscribe control', () => {
    render(<NewsletterSignupForm source="newsletter-page" />);
    expect(screen.getByText(/about twice a month/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /subscribe/i })).toBeTruthy();
  });

  it('posts the email and fires a PII-free PostHog event on success', async () => {
    render(<NewsletterSignupForm source="footer" />);
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'kai@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));

    await waitFor(() => expect(screen.getByText(/check your inbox/i)).toBeTruthy());

    expect(fetch).toHaveBeenCalledWith(
      '/api/newsletter/subscribe',
      expect.objectContaining({ method: 'POST' })
    );
    expect(captureMock).toHaveBeenCalledWith('newsletter_signup', {
      source: 'footer',
      email_domain: 'example.com',
    });
  });

  it('shows an error message when the API rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    render(<NewsletterSignupForm source="blog" />);
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'kai@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('silently succeeds without posting when the honeypot is filled (bot)', async () => {
    render(<NewsletterSignupForm source="footer" />);
    fireEvent.change(screen.getByLabelText(/leave this field empty/i), {
      target: { value: 'i-am-a-bot' },
    });
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'bot@spam.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));

    await waitFor(() => expect(screen.getByText(/check your inbox/i)).toBeTruthy());
    expect(fetch).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });
});
