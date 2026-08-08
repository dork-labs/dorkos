// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import LexicalField from '../LexicalField';
import type { MentionSubject } from '../use-mention-nodes';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

const ROSTER: readonly MentionSubject[] = [
  { handle: 'ana', identityColor: '#7c5cff', kind: 'agent' },
  { handle: 'kai', identityColor: null, kind: 'human' },
];

/** The field with a roster, wired the way a room would wire it. */
function Harness({
  initialValue,
  mentionSubjects,
  onValue,
}: {
  initialValue: string;
  mentionSubjects?: readonly MentionSubject[];
  onValue?: (v: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <LexicalField
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
      onKeyDown={() => {}}
      onFocus={() => {}}
      onBlur={() => {}}
      placeholder="Send a message..."
      onSurfaceChange={() => {}}
      mentionSubjects={mentionSubjects}
    />
  );
}

describe('a typed handle becomes the identity pill', () => {
  it('promotes a handle that is in the roster', async () => {
    render(<Harness initialValue="hi @ana" mentionSubjects={ROSTER} />);
    const field = await screen.findByRole('combobox');

    await waitFor(() => {
      const pill = field.querySelector('[data-slot="mention-pill"]');
      expect(pill).not.toBeNull();
      expect(pill!.getAttribute('data-kind')).toBe('agent');
      expect(pill!.textContent).toBe('@ana');
    });
  });

  it('draws a human handle as the neutral pill', async () => {
    render(<Harness initialValue="hi @kai" mentionSubjects={ROSTER} />);
    const field = await screen.findByRole('combobox');

    await waitFor(() => expect(field.querySelector('[data-kind="human"]')).not.toBeNull());
  });

  it('leaves a handle nobody in the roster answers to as plain text', async () => {
    render(<Harness initialValue="hi @nobody" mentionSubjects={ROSTER} />);
    const field = await screen.findByRole('combobox');
    await waitFor(() => expect(field.textContent).toBe('hi @nobody'));

    expect(field.querySelector('[data-slot="mention-pill"]')).toBeNull();
  });

  // Every surface without a roster — chat, the dashboard, onboarding — passes
  // nothing, and must get no pills at all.
  it('draws no pills at all when the host gives no roster', async () => {
    render(<Harness initialValue="hi @ana" />);
    const field = await screen.findByRole('combobox');
    await waitFor(() => expect(field.textContent).toBe('hi @ana'));

    expect(field.querySelector('[data-slot="mention-pill"]')).toBeNull();
  });

  // The pill's text IS the handle, so it rides the ordinary text path and the
  // value the host sees is unchanged by the promotion.
  it('changes nothing about the markdown the host receives', async () => {
    const seen: string[] = [];
    render(
      <Harness initialValue="hi @ana" mentionSubjects={ROSTER} onValue={(v) => seen.push(v)} />
    );
    const field = await screen.findByRole('combobox');
    await waitFor(() => expect(field.querySelector('[data-slot="mention-pill"]')).not.toBeNull());

    for (const value of seen) expect(value).toBe('hi @ana');
  });

  it('promotes two adjacent handles independently', async () => {
    render(<Harness initialValue="@ana @kai" mentionSubjects={ROSTER} />);
    const field = await screen.findByRole('combobox');

    await waitFor(() =>
      expect(field.querySelectorAll('[data-slot="mention-pill"]').length).toBe(2)
    );
  });

  it('promotes a handle followed by punctuation without swallowing it', async () => {
    render(<Harness initialValue="see @ana, thanks" mentionSubjects={ROSTER} />);
    const field = await screen.findByRole('combobox');

    await waitFor(() => {
      const pill = field.querySelector('[data-slot="mention-pill"]');
      expect(pill?.textContent).toBe('@ana');
    });
    expect(field.textContent).toBe('see @ana, thanks');
  });
});
