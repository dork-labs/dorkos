/**
 * OpenCode cloud (OpenRouter) connect path (ADR-0318; spec opencode-connect §5).
 *
 * The recommended "best models, zero setup" path: paste an OpenRouter key or run
 * the ToS-clean OAuth-PKCE flow. OAuth is browser-only — in the Obsidian embedding
 * (`getPlatform().isEmbedded`) it degrades to the always-available paste-key path
 * rather than crashing on the stubbed transport. Model choice is no longer picked
 * here — it moved to the toolbar model menu; on success this path reports the
 * connect so the dialog shows its success moment.
 *
 * @module features/runtime-connect/ui/OpenRouterGatewayPath
 */
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button, Label, PasswordInput } from '@/layers/shared/ui';
import type { RuntimeConnectSuccess } from '@/layers/entities/runtime';
import { getPlatform } from '@/layers/shared/lib';
import { useOpenRouterOAuth, useStoreOpenRouterKey } from '../model/use-openrouter-connect';
import { CLOUD_CONNECT_SUCCESS } from '../lib/connect-success';
import { ConnectErrorRow, ConnectProgressRow, ConnectedRow } from './connect-feedback';

const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

/** The cloud (OpenRouter) connect path: paste-key + (browser-only) OAuth-PKCE. */
export function OpenRouterGatewayPath({
  onConnected,
}: {
  /** Reports the connect landing so the dialog can show its success moment. */
  onConnected?: (success: RuntimeConnectSuccess) => void;
}) {
  const [key, setKey] = useState('');
  const store = useStoreOpenRouterKey();
  const oauth = useOpenRouterOAuth();
  // OAuth-PKCE hosts a loopback callback + opens a browser tab — desktop-server
  // only. Detected via the platform adapter, not window sniffing.
  const oauthAvailable = !getPlatform().isEmbedded;

  const connected = store.isSuccess || oauth.isSuccess;

  useEffect(() => {
    if (connected) onConnected?.(CLOUD_CONNECT_SUCCESS);
  }, [connected, onConnected]);

  if (connected) {
    // Standalone (no success panel wired): a brief inline confirmation before the
    // surface flips to Ready. In the dialog's success flow this unmounts at once.
    return <ConnectedRow message="Connected to OpenRouter" />;
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
