// @vitest-environment jsdom
/**
 * The receipt under `prefers-reduced-motion`.
 *
 * Its own `motion/react` mock (the global one in `test-setup.ts` always answers
 * "no preference") reports a reduced-motion preference AND records the props
 * the component hands to `motion.div`, so the test can prove the line arrives
 * with no travel rather than merely that it arrives.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('motion/react', () => {
  const motion = new Proxy(
    {},
    {
      get:
        (_target: unknown, tag: string) =>
        ({
          children,
          initial,
          transition,
          ...rest
        }: {
          children?: React.ReactNode;
          initial?: unknown;
          transition?: { duration?: number };
          [key: string]: unknown;
        }) => {
          const Tag = tag as 'div';
          return (
            <Tag
              {...(rest as Record<string, unknown>)}
              data-initial={JSON.stringify(initial ?? null)}
              data-duration={String(transition?.duration ?? '')}
            >
              {children}
            </Tag>
          );
        },
    }
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => true,
  };
});

const { AskReceipt } = await import('../ui/AskReceipt');

afterEach(cleanup);

describe('AskReceipt under reduced motion', () => {
  it('lands in place with no travel and no duration', () => {
    // Purpose: reduced motion is a request for no movement, not for a shorter
    // movement. The receipt must appear already settled.
    render(
      <AskReceipt
        outcome="allowed"
        items={[{ toolCallId: 'tc-1', label: 'Run "npm test"' }]}
        resolvedAt={1_700_000_005_000}
        startedAt={1_700_000_000_000}
      />
    );

    const receipt = screen.getByTestId('approval-receipt');
    // `initial={false}` — no from-state to animate out of.
    expect(receipt.getAttribute('data-initial')).toBe('false');
    expect(receipt.getAttribute('data-duration')).toBe('0');
    // And the line itself still reads correctly.
    expect(receipt.textContent).toContain('You allowed');
    expect(receipt.textContent).toContain('Run "npm test"');
  });

  it('still expands a batch receipt when motion is off', () => {
    // Purpose: the expander is information, not decoration — turning motion off
    // must not take the detail with it.
    render(
      <AskReceipt
        outcome="denied"
        items={[
          { toolCallId: 'tc-1', label: 'Run "a"' },
          { toolCallId: 'tc-2', label: 'Run "b"' },
        ]}
      />
    );

    expect(screen.getByTestId('approval-receipt').textContent).toContain('You denied 2 actions');
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.getByTestId('approval-receipt-items').textContent).toContain('Run "b"');
  });
});
