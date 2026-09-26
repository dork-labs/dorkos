/**
 * @vitest-environment jsdom
 */
/**
 * The name-and-handle form (DOR-677): one confirm over the two routes Settings
 * › Profile already uses. The cases pin what that single confirm must not get
 * wrong — a refused handle must not cost the person their saved name, and a
 * retry must re-send only what is still unsaved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { OperatorIdentityForm } from '../ui/fields/OperatorIdentityForm';

let self: TeamMember;
let mockTransport: ReturnType<typeof createMockTransport>;

async function renderForm(onSaved = vi.fn()) {
  mockTransport = createMockTransport();
  // The roster answers with whatever `self` is NOW, so a save that refetches
  // sees the stored values move exactly as the real server's would.
  vi.mocked(mockTransport.getTeamRoster).mockImplementation(() =>
    Promise.resolve({ members: [self] } as Awaited<ReturnType<typeof mockTransport.getTeamRoster>>)
  );
  vi.mocked(mockTransport.updateProfile).mockImplementation((displayName: string) => {
    self = { ...self, displayName };
    return Promise.resolve({ displayName });
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <OperatorIdentityForm onSaved={onSaved} />
      </TransportProvider>
    </QueryClientProvider>
  );
  await waitFor(() => expect(screen.getByLabelText('Your name')).not.toBeDisabled());
  return onSaved;
}

describe('OperatorIdentityForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    self = {
      id: 'author-self',
      kind: 'human',
      displayName: 'You',
      handle: null,
      isSelf: true,
      ownerId: null,
      origin: 'local',
      person: { role: null, lastSeenAt: null },
    };
  });
  afterEach(() => cleanup());

  it('keeps a saved name when the handle is refused, and retries only the handle', async () => {
    const onSaved = await renderForm();
    vi.mocked(mockTransport.setAuthorHandle).mockRejectedValueOnce(
      Object.assign(new Error('reserved'), { code: 'HANDLE_RESERVED' })
    );

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Kai' } });
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'everyone' } });
    fireEvent.click(screen.getByTestId('confirm-identity'));

    expect(await screen.findByText(/@everyone is spoken for/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(mockTransport.updateProfile).toHaveBeenCalledTimes(1);
    // The name survived the refusal: still in the field, still saved.
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Kai');

    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'kai' } });
    // Typing is acting on the refusal, so its sentence goes.
    expect(screen.queryByText(/@everyone is spoken for/)).toBeNull();
    fireEvent.click(screen.getByTestId('confirm-identity'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockTransport.updateProfile).toHaveBeenCalledTimes(1);
    expect(mockTransport.setAuthorHandle).toHaveBeenLastCalledWith('author-self', 'kai');
  });

  it('confirming values that are already stored saves nothing and still answers', async () => {
    self = { ...self, displayName: 'Kai', handle: 'kai' };
    const onSaved = await renderForm();

    fireEvent.click(screen.getByTestId('confirm-identity'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockTransport.updateProfile).not.toHaveBeenCalled();
    expect(mockTransport.setAuthorHandle).not.toHaveBeenCalled();
  });

  it('cannot be confirmed empty', async () => {
    await renderForm();
    expect(screen.getByTestId('confirm-identity')).toBeDisabled();
  });
});
