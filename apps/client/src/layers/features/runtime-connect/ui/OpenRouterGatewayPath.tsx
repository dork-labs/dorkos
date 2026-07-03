/**
 * OpenCode Gateway (OpenRouter) path (ADR-0318, T1 task 2.8).
 *
 * One key, every model: paste an OpenRouter key or run the ToS-clean OAuth-PKCE
 * flow, then pick from the OpenRouter catalog. OAuth is browser-only — in the
 * Obsidian embedding (`getPlatform().isEmbedded`) it degrades to the
 * always-available paste-key path rather than crashing on the stubbed transport.
 *
 * @module features/runtime-connect/ui/OpenRouterGatewayPath
 */
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button, Label, PasswordInput } from '@/layers/shared/ui';
import { getPlatform } from '@/layers/shared/lib';
import {
  useOpenRouterModels,
  useOpenRouterOAuth,
  useStoreOpenRouterKey,
} from '../model/use-openrouter-connect';
import { ConnectErrorRow, ConnectProgressRow } from './connect-feedback';

const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

/** The Gateway (OpenRouter) connect path: paste-key + (browser-only) OAuth-PKCE. */
export function OpenRouterGatewayPath() {
  const [key, setKey] = useState('');
  const store = useStoreOpenRouterKey();
  const oauth = useOpenRouterOAuth();
  // OAuth-PKCE hosts a loopback callback + opens a browser tab — desktop-server
  // only. Detected via the platform adapter, not window sniffing.
  const oauthAvailable = !getPlatform().isEmbedded;

  const connected = store.isSuccess || oauth.isSuccess;

  if (connected) {
    return <ModelPicker />;
  }

  return (
    <div className="space-y-4" data-testid="openrouter-gateway">
      {oauthAvailable && (
        <div className="space-y-2">
          {oauth.isPending ? (
            <ConnectProgressRow message="Finish signing in to OpenRouter in the new tab…" />
          ) : oauth.isError ? (
            <ConnectErrorRow
              message={oauth.errorMessage ?? 'OpenRouter sign-in failed.'}
              onRetry={oauth.begin}
            />
          ) : (
            <>
              <Button size="sm" className="w-full" onClick={oauth.begin}>
                Connect OpenRouter
              </Button>
              <p className="text-muted-foreground text-xs">
                Creates a scoped key automatically — no copy-paste.
              </p>
            </>
          )}
        </div>
      )}

      {oauthAvailable && (
        <div className="flex items-center gap-3">
          <span className="bg-border h-px flex-1" />
          <span className="text-muted-foreground text-2xs tracking-wide uppercase">or</span>
          <span className="bg-border h-px flex-1" />
        </div>
      )}

      {store.isPending ? (
        <ConnectProgressRow message="Checking your OpenRouter key…" />
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            store.store(key);
          }}
        >
          <Label htmlFor="openrouter-key" className="text-xs">
            OpenRouter key
          </Label>
          <PasswordInput
            id="openrouter-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-or-…"
            autoComplete="off"
            spellCheck={false}
          />
          {store.isError && (
            <p className="text-destructive text-xs" role="alert">
              {store.errorMessage}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <a
              href={OPENROUTER_KEYS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
            >
              Get an OpenRouter key <ExternalLink className="size-3" />
            </a>
            <Button type="submit" size="sm" variant="outline" disabled={key.trim().length === 0}>
              Save key
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * The model dropdown, populated from the OpenRouter catalog once connected.
 * OpenCode is already Ready at this point (the key/OAuth invalidated
 * requirements); choosing a model is the follow-on selection.
 */
function ModelPicker() {
  const models = useOpenRouterModels(true);

  return (
    <div className="space-y-2" data-testid="openrouter-models">
      <div className="flex items-center gap-2 text-xs text-emerald-500">
        Connected to OpenRouter
      </div>
      <Label htmlFor="openrouter-model" className="text-xs">
        Model
      </Label>
      <select
        id="openrouter-model"
        className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
        disabled={models.isPending || (models.data?.length ?? 0) === 0}
      >
        {models.isPending && <option>Loading models…</option>}
        {models.data?.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </div>
  );
}
