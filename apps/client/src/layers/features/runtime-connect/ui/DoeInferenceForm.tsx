/** Explicit DorkOS model setup. Passwords stay transient and never return from reads. */
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DoeInferenceConfigSchema, type DoeInferenceConfig } from '@dorkos/shared/config-schema';
import type { DoeInferenceStatus } from '@dorkos/shared/runtime-connect';
import { cloudCreditsKeys, useTransport } from '@/layers/shared/model';
import { Button, Input, Label, PasswordInput, Spinner } from '@/layers/shared/ui';
import { REQUIREMENTS_KEY, type RuntimeConnectSuccess } from '@/layers/entities/runtime';
import { configKeys } from '@/layers/entities/config';
import { MODELS_KEY } from '@/layers/shared/lib';

type Props = { onConnected?: (success: RuntimeConnectSuccess) => void };

/** Load only saved metadata; unmounting clears the password field. */
export function DoeInferenceForm(props: Props) {
  const transport = useTransport();
  const saved = useQuery({
    queryKey: ['doe-inference'],
    queryFn: () => transport.getDoeInference(),
  });
  if (saved.isPending) return <Spinner aria-label="Loading model settings" />;
  if (saved.isError) return <p role="alert">Couldn’t load model settings. Try again.</p>;
  return <InferenceFields key={JSON.stringify(saved.data)} saved={saved.data} {...props} />;
}

function InferenceFields({ saved, onConnected }: Props & { saved: DoeInferenceStatus }) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const prefix = useId();
  const [source, setSource] = useState<DoeInferenceConfig['source']>(
    saved.inference?.source ?? 'api-key'
  );
  const [protocol, setProtocol] = useState<DoeInferenceConfig['protocol']>(
    saved.inference?.protocol ?? 'openai-chat-completions'
  );
  const [endpoint, setEndpoint] = useState(saved.inference?.endpoint ?? '');
  const [provider, setProvider] = useState(saved.inference?.provider ?? '');
  const [model, setModel] = useState(saved.inference?.model ?? '');
  const [contextWindow, setContextWindow] = useState(
    String(saved.inference?.contextWindow ?? 8192)
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    String(saved.inference?.maxOutputTokens ?? 1024)
  );
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const credits = useQuery({
    queryKey: ['doe-credits-models', protocol],
    queryFn: () => transport.getDoeCreditsModels(protocol),
    enabled: source === 'dorkos-credits',
  });
  const selected =
    source === 'dorkos-credits'
      ? credits.data?.models.find((entry) => entry.id === model)
      : undefined;
  const keySaved =
    saved.hasKey && saved.inference?.endpoint === endpoint && saved.inference.source === 'api-key';
  const mutation = useMutation({
    mutationFn: async (inference: DoeInferenceConfig) => {
      if (source === 'api-key' && secret.trim())
        await transport.storeDoeCredential(inference, secret.trim());
      else await transport.setDoeInference(inference);
      const status = await transport.getCloudCredits();
      if (status.linked) await transport.setCloudCreditsDefault('doe', source === 'dorkos-credits');
    },
    onSuccess: () => {
      setSecret('');
      for (const queryKey of [
        ['doe-inference'],
        REQUIREMENTS_KEY,
        MODELS_KEY,
        configKeys.all,
        cloudCreditsKeys.status(),
      ])
        void queryClient.invalidateQueries({ queryKey });
      onConnected?.({
        title: 'DorkOS model settings saved',
        body: 'New chats use this source and model.',
      });
    },
    onError: () => setError('Couldn’t save model settings. Try again.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (secret.trim().startsWith('sk-ant-oat')) {
      setError('Anthropic subscription tokens cannot run DorkOS agents. Use an API key.');
      return;
    }
    if (source === 'api-key' && !secret.trim() && !keySaved) {
      setError('Enter an API key.');
      return;
    }
    if (source === 'dorkos-credits' && (!selected || !credits.data?.endpoint)) {
      setError('Link DorkOS credits and choose an available model.');
      return;
    }
    const parsed = DoeInferenceConfigSchema.safeParse({
      source,
      protocol,
      provider: source === 'dorkos-credits' ? 'dorkos' : provider,
      endpoint: source === 'dorkos-credits' ? credits.data?.endpoint : endpoint,
      model,
      contextWindow: selected?.contextWindow ?? Number(contextWindow),
      maxOutputTokens: selected?.maxOutputTokens ?? Number(maxOutputTokens),
    });
    if (!parsed.success) {
      setError('Check the model, endpoint, and token limits.');
      return;
    }
    mutation.mutate(parsed.data);
  }
  const selectClass =
    'bg-background border-input focus-visible:ring-ring h-11 w-full rounded-md md:h-9 border px-3 text-sm focus-visible:ring-2';
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="DorkOS model settings">
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-source`}>Runs on</Label>
        <select
          id={`${prefix}-source`}
          className={selectClass}
          value={source}
          onChange={(event) => {
            setSource(event.target.value as typeof source);
            setModel('');
          }}
        >
          <option value="api-key">My API key</option>
          <option value="local">Local model</option>
          <option value="dorkos-credits">DorkOS credits</option>
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-protocol`}>Model protocol</Label>
        <select
          id={`${prefix}-protocol`}
          className={selectClass}
          value={protocol}
          onChange={(event) => {
            setProtocol(event.target.value as typeof protocol);
            if (source === 'dorkos-credits') setModel('');
          }}
        >
          <option value="openai-chat-completions">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
      </div>
      {source === 'dorkos-credits' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-model`}>Model</Label>
          <select
            id={`${prefix}-model`}
            className={selectClass}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={credits.isPending || !credits.data?.endpoint}
          >
            <option value="">Choose a model</option>
            {credits.data?.models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.displayName}
              </option>
            ))}
          </select>
          {!credits.data?.endpoint && (
            <p className="text-muted-foreground text-xs">
              Link DorkOS credits in Settings to choose a model.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-service`}>Service name</Label>
            <Input
              id={`${prefix}-service`}
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-endpoint`}>Model endpoint</Label>
            <Input
              id={`${prefix}-endpoint`}
              type="url"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              required
            />
            {source === 'local' && (
              <p className="text-muted-foreground text-xs">
                Use a loopback address. No API key is needed.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-model`}>Model ID</Label>
            <Input
              id={`${prefix}-model`}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-context`}>Context tokens</Label>
              <Input
                id={`${prefix}-context`}
                type="number"
                min={1}
                value={contextWindow}
                onChange={(event) => setContextWindow(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-output`}>Output tokens</Label>
              <Input
                id={`${prefix}-output`}
                type="number"
                min={1}
                value={maxOutputTokens}
                onChange={(event) => setMaxOutputTokens(event.target.value)}
                required
              />
            </div>
          </div>
          {source === 'api-key' && (
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-key`}>API key</Label>
              <PasswordInput
                id={`${prefix}-key`}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
              />
              {keySaved && (
                <p className="text-muted-foreground text-xs">
                  API key saved. Leave blank to keep it.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save model settings'}
      </Button>
    </form>
  );
}
