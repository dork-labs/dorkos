/**
 * OpenCode Direct-provider path (ADR-0318, T1 task 2.8).
 *
 * Bring your existing key: a provider id, a pasted key (stored by reference),
 * and an optional OpenAI-compatible base URL. On success OpenCode flips to
 * Ready. The key is a password field and unmounts on success — never echoed.
 *
 * @module features/runtime-connect/ui/DirectProviderPath
 */
import { useEffect, useState } from 'react';
import { Button, Input, Label, PasswordInput } from '@/layers/shared/ui';
import type { RuntimeConnectSuccess } from '@/layers/entities/runtime';
import { useConnectDirectProvider } from '../model/use-opencode-provider';
import { DIRECT_CONNECT_SUCCESS } from '../lib/connect-success';
import { ConnectProgressRow, ConnectedRow } from './connect-feedback';

/** The Direct-provider connect path: provider id + key + optional base URL. */
export function DirectProviderPath({
  onConnected,
}: {
  /** Reports the connect landing so the dialog can show its success moment. */
  onConnected?: (success: RuntimeConnectSuccess) => void;
}) {
  const [providerId, setProviderId] = useState('openai');
  const [key, setKey] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const connect = useConnectDirectProvider();

  useEffect(() => {
    if (connect.isSuccess) onConnected?.(DIRECT_CONNECT_SUCCESS);
  }, [connect.isSuccess, onConnected]);

  if (connect.isPending) {
    return <ConnectProgressRow message="Saving your provider key…" />;
  }
  if (connect.isSuccess) {
    return <ConnectedRow />;
  }

  return (
    <form
      className="space-y-3"
      data-testid="direct-provider"
      onSubmit={(e) => {
        e.preventDefault();
        connect.connect({ providerId, key, baseURL });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="direct-provider-id" className="text-xs">
          Provider
        </Label>
        <Input
          id="direct-provider-id"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          placeholder="openai"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="direct-provider-key" className="text-xs">
          API key
        </Label>
        <PasswordInput
          id="direct-provider-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-…"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="direct-provider-base-url" className="text-xs">
          Base URL <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="direct-provider-base-url"
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          placeholder="https://api.example.com/v1"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {connect.isError && (
        <p className="text-destructive text-xs" role="alert">
          {connect.errorMessage}
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        className="w-full"
        disabled={key.trim().length === 0 || providerId.trim().length === 0}
      >
        Connect provider
      </Button>
    </form>
  );
}
