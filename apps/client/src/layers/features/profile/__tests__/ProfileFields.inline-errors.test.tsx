/**
 * @vitest-environment jsdom
 */
/**
 * Settings › Profile's name and handle fields keep a refusal out of the shared
 * toast only while they are on screen to draw it (`meta.isShownInline`,
 * `shared/lib/query-client.ts`). A save that fails after Settings closed has no
 * field left to show it under, so it must toast or be seen nowhere.
 *
 * Mounted over the app's REAL query-client config, so the toast policy under
 * test is the one the app runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createMockTransport } from '@dorkos/test-utils';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib/query-client';
import { ProfileHandleField, ProfileNameField } from '../ui/fields/ProfileFields';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const member: TeamMember = {
  id: 'author-self',
  kind: 'human',
  displayName: 'Kai',
  handle: 'kai',
  isSelf: true,
  ownerId: null,
  origin: 'local',
  person: { role: null, lastSeenAt: null },
};

let mockTransport: ReturnType<typeof createMockTransport>;

function mount(field: 'name' | 'handle') {
  mockTransport = createMockTransport();
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        {field === 'name' ? (
          <ProfileNameField member={member} />
        ) : (
          <ProfileHandleField member={member} />
        )}
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Type a new value into the field and press its Save. */
function submit(field: 'name' | 'handle', value: string) {
  fireEvent.change(screen.getByLabelText(field === 'name' ? 'Display name' : 'Handle'), {
    target: { value },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('Settings › Profile refusals: inline while shown, toast once gone', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('a refused handle is drawn under the field and not toasted', async () => {
    mount('handle');
    vi.mocked(mockTransport.setAuthorHandle).mockRejectedValueOnce(
      Object.assign(new Error('taken'), { code: 'HANDLE_TAKEN' })
    );
    submit('handle', 'ana');

    expect(
      await screen.findByText('@ana belongs to someone else. Pick a different one.')
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a refused name is drawn under the field and not toasted', async () => {
    mount('name');
    vi.mocked(mockTransport.updateProfile).mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'OPERATOR_ONLY' })
    );
    submit('name', 'Ana');

    expect(
      await screen.findByText('Only the person at the keyboard can change this name.')
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['name', 'handle'] as const)(
    'a %s refusal that lands after Settings closed still toasts',
    async (field) => {
      const rendered = mount(field);
      let reject!: (error: Error) => void;
      const pending = () => new Promise<never>((_resolve, rej) => (reject = rej));
      if (field === 'name') vi.mocked(mockTransport.updateProfile).mockImplementationOnce(pending);
      else vi.mocked(mockTransport.setAuthorHandle).mockImplementationOnce(pending);

      submit(field, 'ana');
      await waitFor(() => expect(reject).toBeTypeOf('function'));

      rendered.unmount();
      reject(new Error('The server said no.'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    }
  );
});
