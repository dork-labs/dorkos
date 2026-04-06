import { Check, Copy, KeyRound } from 'lucide-react';
import { Badge, Button, SettingRow } from '@/layers/shared/ui';
import { useCopyFeedback } from '@/layers/shared/lib';

interface ApiKeySectionProps {
  authConfigured: boolean;
  authSource: 'config' | 'env' | 'none';
  generatedKey: string | null;
  keyError: string | null;
  onGenerate: () => void;
  onRotate: () => void;
  onRemove: () => void;
}

/** API key section with distinct visual states for none/generated/configured/env. */
export function ApiKeySection({
  authConfigured,
  authSource,
  generatedKey,
  keyError,
  onGenerate,
  onRotate,
  onRemove,
}: ApiKeySectionProps) {
  const [copied, copy] = useCopyFeedback();

  // Env var managed — read-only
  if (authSource === 'env') {
    return (
      <SettingRow label="API Key" description="Set via MCP_API_KEY environment variable">
        <Badge variant="outline">Environment variable</Badge>
      </SettingRow>
    );
  }

  // No key configured — prompt to generate
  if (!authConfigured && !generatedKey) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">API Key</p>
            <p className="text-muted-foreground text-xs">
              Protect the MCP endpoint with bearer token auth
            </p>
          </div>
          <Button size="sm" onClick={onGenerate}>
            <KeyRound className="mr-1.5 size-3.5" />
            Generate Key
          </Button>
        </div>
        {keyError && (
          <p className="text-xs text-red-500" role="alert">
            {keyError}
          </p>
        )}
      </div>
    );
  }

  // Just generated — one-time reveal
  if (generatedKey) {
    return (
      <div className="space-y-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">API Key</p>
          <p className="text-muted-foreground text-xs">
            Copy this key now — it won&apos;t be shown again
          </p>
        </div>
        <div className="flex items-center gap-2">
          <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
            {generatedKey}
          </code>
          <button
            className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-1.5 transition-colors"
            onClick={() => copy(generatedKey)}
            aria-label="Copy API key"
          >
            {copied ? <Check className="size-4 text-green-500" /> : <Copy className="size-4" />}
          </button>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onRotate}>
            Rotate
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
        {keyError && (
          <p className="text-xs text-red-500" role="alert">
            {keyError}
          </p>
        )}
      </div>
    );
  }

  // Key exists in config — masked display with actions
  return (
    <div className="space-y-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">API Key</p>
        <p className="text-muted-foreground text-xs">Bearer token for MCP authentication</p>
      </div>
      <div className="flex items-center gap-2">
        <code className="bg-muted rounded-md px-3 py-2 font-mono text-xs">dork_mcp_••••••••</code>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onRotate}>
          Rotate
        </Button>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {keyError && (
        <p className="text-xs text-red-500" role="alert">
          {keyError}
        </p>
      )}
    </div>
  );
}
