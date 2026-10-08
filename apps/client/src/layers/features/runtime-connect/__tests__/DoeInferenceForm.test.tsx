// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { DoeInferenceForm } from '../ui/DoeInferenceForm';

const inference = {
  source: 'api-key' as const,
  provider: 'openai',
  protocol: 'openai-chat-completions' as const,
  endpoint: 'https://example.com/v1',
  model: 'test-model',
  contextWindow: 8192,
  maxOutputTokens: 1024,
};
afterEach(cleanup);
function setup(overrides: Parameters<typeof createMockTransport>[0] = {}) {
  const transport = createMockTransport({
    getDoeInference: vi.fn().mockResolvedValue({ inference, hasKey: true }),
    ...overrides,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <DoeInferenceForm />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('explicit DorkOS inference setup', () => {
  it('shows metadata and stored-key status, and keeps a saved key without reading it', async () => {
    const transport = setup();
    const user = userEvent.setup();
    await screen.findByText('API key saved. Leave blank to keep it.');
    expect(screen.getByLabelText('API key')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save model settings' }));
    await waitFor(() => expect(transport.setDoeInference).toHaveBeenCalledWith(inference));
    expect(transport.storeDoeCredential).not.toHaveBeenCalled();
    expect(transport.getDoeCreditsModels).not.toHaveBeenCalled();
  });
  it('rejects a subscription token before sending or persisting it', async () => {
    const transport = setup();
    const user = userEvent.setup();
    await screen.findByText('API key saved. Leave blank to keep it.');
    await user.type(screen.getByLabelText('API key'), 'sk-ant-oat-fixture');
    await user.click(screen.getByRole('button', { name: 'Save model settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('subscription tokens');
    expect(transport.setDoeInference).not.toHaveBeenCalled();
    expect(transport.storeDoeCredential).not.toHaveBeenCalled();
  });
  it('saves a credential-free loopback model with an explicit protocol', async () => {
    const transport = setup();
    const user = userEvent.setup();
    await screen.findByLabelText('Runs on');
    await user.selectOptions(screen.getByLabelText('Runs on'), 'local');
    await user.selectOptions(screen.getByLabelText('Model protocol'), 'openai-responses');
    await user.clear(screen.getByLabelText('Model endpoint'));
    await user.type(screen.getByLabelText('Model endpoint'), 'http://127.0.0.1:11434/v1');
    await user.type(screen.getByLabelText('Model ID'), 'local-model');
    await user.click(screen.getByRole('button', { name: 'Save model settings' }));
    await waitFor(() =>
      expect(transport.setDoeInference).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'local',
          protocol: 'openai-responses',
          model: 'local-model',
        })
      )
    );
    expect(transport.storeDoeCredential).not.toHaveBeenCalled();
  });
  it('offers the selected-format credits catalog and saves the explicitly chosen model', async () => {
    const transport = setup({
      getDoeCreditsModels: vi.fn().mockResolvedValue({
        endpoint: 'https://credits.example/v1',
        models: [
          {
            id: 'credits-model',
            displayName: 'Credits model',
            contextWindow: 16000,
            maxOutputTokens: 2000,
          },
        ],
      }),
    });
    const user = userEvent.setup();
    await screen.findByLabelText('Runs on');
    await user.selectOptions(screen.getByLabelText('Runs on'), 'dorkos-credits');
    await screen.findByRole('option', { name: 'Credits model' });
    await user.selectOptions(screen.getByLabelText('Model'), 'credits-model');
    await user.click(screen.getByRole('button', { name: 'Save model settings' }));
    await waitFor(() =>
      expect(transport.setDoeInference).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'dorkos-credits',
          provider: 'dorkos',
          endpoint: 'https://credits.example/v1',
          model: 'credits-model',
          contextWindow: 16000,
        })
      )
    );
    expect(transport.getDoeCreditsModels).toHaveBeenCalledWith('openai-chat-completions');
    expect(transport.storeDoeCredential).not.toHaveBeenCalled();
  });
});
