/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StepUpRiskRow } from '../ui/StepUpRiskRow';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderRow(props: Parameters<typeof StepUpRiskRow>[0]) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StepUpRiskRow {...props} />
    </QueryClientProvider>
  );
}

describe('StepUpRiskRow', () => {
  it('a mini app in an agent’s folder: says why, and moves it out on a press', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    renderRow({
      risk: {
        id: 'sq',
        name: 'Social queue',
        reason: 'agent-folder',
        agentName: 'dorkos-marketing',
      },
      id: 'sq',
      name: 'Social queue',
      onTurnOff: vi.fn(),
      isToggling: false,
    });
    expect(screen.getByText('dorkos-marketing can edit this, so confirming is off.')).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Move out of dorkos-marketing’s folder' })
    );
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/extensions\/sq\/move-out$/);
    expect((init as RequestInit).method).toBe('POST');
  });

  it('a changed mini app: says so, and turns it off with the card’s own toggle', async () => {
    const onTurnOff = vi.fn();
    renderRow({
      risk: { id: 'n', name: 'Notes', reason: 'changed' },
      id: 'n',
      name: 'Notes',
      onTurnOff,
      isToggling: false,
    });
    expect(screen.getByText('Changed since you approved it, so confirming is off.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(onTurnOff).toHaveBeenCalledTimes(1);
  });
});
