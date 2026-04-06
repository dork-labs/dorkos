/**
 * Rate limiting section for the External MCP card.
 *
 * Renders a toggle plus conditionally-shown max-requests / window-secs inputs.
 *
 * @module features/settings/ui/external-mcp/RateLimitSection
 */

import type { ServerConfig } from '@dorkos/shared/types';
import { Input, SettingRow, Switch } from '@/layers/shared/ui';

type McpConfig = NonNullable<ServerConfig['mcp']>;

interface RateLimitSectionProps {
  rateLimit: McpConfig['rateLimit'];
  onUpdate: (patch: Partial<McpConfig['rateLimit']>) => void;
}

/** Rate limiting toggle plus max-requests/window-secs inputs. */
export function RateLimitSection({ rateLimit, onUpdate }: RateLimitSectionProps) {
  return (
    <div className="space-y-3">
      <SettingRow label="Rate limiting" description="Limit external MCP requests per time window">
        <Switch
          checked={rateLimit.enabled}
          onCheckedChange={(v) => onUpdate({ enabled: v })}
          aria-label="Toggle rate limiting"
        />
      </SettingRow>
      {rateLimit.enabled && (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label htmlFor="mcp-max-requests" className="text-muted-foreground text-xs">
                Max requests
              </label>
              <Input
                id="mcp-max-requests"
                type="number"
                min={1}
                max={1000}
                value={rateLimit.maxPerWindow}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (v >= 1 && v <= 1000) onUpdate({ maxPerWindow: v });
                }}
                className="w-20"
              />
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="mcp-window-secs" className="text-muted-foreground text-xs">
                Window (sec)
              </label>
              <Input
                id="mcp-window-secs"
                type="number"
                min={1}
                max={3600}
                value={rateLimit.windowSecs}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (v >= 1 && v <= 3600) onUpdate({ windowSecs: v });
                }}
                className="w-20"
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            Rate limit changes take effect after server restart.
          </p>
        </div>
      )}
    </div>
  );
}
