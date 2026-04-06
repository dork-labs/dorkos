import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { buildSnippets } from '../../lib/external-mcp-snippets';

interface SetupInstructionsProps {
  endpoint: string;
  apiKey: string | null;
}

type SetupTab = 'claude-code' | 'cursor' | 'windsurf';

/** Collapsible per-client setup snippet panel for the External MCP card. */
export function SetupInstructions({ endpoint, apiKey }: SetupInstructionsProps) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupTab, setSetupTab] = useState<SetupTab>('claude-code');
  const snippets = buildSnippets(endpoint, apiKey);

  const activeSnippet =
    setupTab === 'claude-code'
      ? snippets.claudeCode
      : setupTab === 'cursor'
        ? snippets.cursor
        : snippets.windsurf;

  return (
    <Collapsible open={setupOpen} onOpenChange={setSetupOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between text-sm font-medium">
        <span>Setup Instructions</span>
        <ChevronDown
          className={cn(
            'text-muted-foreground size-3.5 transition-transform duration-150',
            !setupOpen && '-rotate-90'
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-3 space-y-3">
          {/* Tab buttons */}
          <div className="bg-muted flex gap-0.5 rounded-md p-0.5">
            {(['claude-code', 'cursor', 'windsurf'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setSetupTab(tab)}
                className={cn(
                  'flex-1 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors',
                  setupTab === tab
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab === 'claude-code' ? 'Claude Code' : tab === 'cursor' ? 'Cursor' : 'Windsurf'}
              </button>
            ))}
          </div>

          {/* Snippet */}
          <div className="relative">
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
              {activeSnippet}
            </pre>
            <div className="absolute top-2 right-2">
              <CopyButton value={activeSnippet} />
            </div>
          </div>

          {/* CLI command for Claude Code */}
          {setupTab === 'claude-code' && (
            <div className="relative">
              <p className="text-muted-foreground mb-1 text-xs">Or add via CLI:</p>
              <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
                {snippets.claudeCodeCli}
              </pre>
              <div className="absolute right-2 bottom-2">
                <CopyButton value={snippets.claudeCodeCli} />
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
