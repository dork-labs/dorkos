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
import { toast } from 'sonner';
import { createMockTransport } from '@dorkos/test-utils';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib/query-client';
import { OperatorIdentityForm } from '../ui/fields/OperatorIdentityForm';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

let self: TeamMember;
let mockTransport: ReturnType<typeof createMockTransport>;

async function renderForm(onSaved = vi.fn()) {
  return (await mountForm(onSaved)).onSaved;
}

/**
 * Mount the form over the app's REAL query-client config, so the shared
 * mutation toast policy (`query-client.ts`) runs exactly as it does in the app.
 */
async function mountForm(onSaved = vi.fn()) {
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
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false },
    },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <OperatorIdentityForm onSaved={onSaved} />
      </TransportProvider>
    </QueryClientProvider>
  );
  await waitFor(() => expect(screen.getByLabelText('Your name')).not.toBeDisabled());
  return { rendered, onSaved };
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

  it('re-saves an agent-suggested name confirmed unchanged, so it becomes the person’s (DOR-1022)', async () => {
    self = {
      ...self,
      displayName: 'Dorian',
      handle: 'dorian',
      person: { role: null, lastSeenAt: null, nameSuggestedBy: 'DorkBot' },
    };
    const onSaved = await renderForm();
    // The same note Settings › Profile draws, so the person knows what saving does.
    expect(screen.getByText('Suggested by DorkBot. Save it to make it yours.')).toBeTruthy();

    fireEvent.click(screen.getByTestId('confirm-identity'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockTransport.updateProfile).toHaveBeenCalledWith('Dorian');
    // The handle was already right; nothing to re-send there.
    expect(mockTransport.setAuthorHandle).not.toHaveBeenCalled();
  });

  it('keeps the refusal out of the toast while it is drawn under the field', async () => {
    await renderForm();
    vi.mocked(mockTransport.setAuthorHandle).mockRejectedValueOnce(
      Object.assign(new Error('taken'), { code: 'HANDLE_TAKEN' })
    );
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'kai' } });
    fireEvent.click(screen.getByTestId('confirm-identity'));

    expect(
      await screen.findByText('@kai belongs to someone else. Pick a different one.')
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still toasts a failure that lands after the form closed mid-save', async () => {
    // Collapsing the getting-started row, dismissing the card or closing
    // Settings mid-save leaves no field to draw the refusal under; the shared
    // toast is then the only place it can be seen (query-client.ts).
    const { rendered } = await mountForm();
    let reject!: (error: Error) => void;
    vi.mocked(mockTransport.setAuthorHandle).mockImplementationOnce(
      () => new Promise((_resolve, rej) => (reject = rej))
    );
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'kai' } });
    fireEvent.click(screen.getByTestId('confirm-identity'));
    await waitFor(() => expect(mockTransport.setAuthorHandle).toHaveBeenCalled());

    rendered.unmount();
    reject(Object.assign(new Error('@kai belongs to somebody else.'), { code: 'HANDLE_TAKEN' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  });
});
