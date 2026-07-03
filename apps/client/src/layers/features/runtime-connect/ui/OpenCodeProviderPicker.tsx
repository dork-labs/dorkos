/**
 * OpenCode provider picker (ADR-0318, T1 task 2.8).
 *
 * OpenCode's connect is "choose where the model comes from," presented as three
 * paths with the two easy ones featured first: Local (Ollama, zero-auth hero),
 * Gateway (OpenRouter), and Direct (your own key). Any successful connection
 * flips OpenCode to Ready via `['requirements']` invalidation inside each path.
 *
 * @module features/runtime-connect/ui/OpenCodeProviderPicker
 */
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/layers/shared/ui';
import { OllamaLocalPath } from './OllamaLocalPath';
import { OpenRouterGatewayPath } from './OpenRouterGatewayPath';
import { DirectProviderPath } from './DirectProviderPath';

type ProviderTab = 'local' | 'gateway' | 'direct';

/** The OpenCode provider picker — Local / Gateway / Direct. */
export function OpenCodeProviderPicker() {
  const [tab, setTab] = useState<ProviderTab>('local');

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as ProviderTab)}
      data-testid="opencode-provider-picker"
    >
      <TabsList className="w-full">
        <TabsTrigger value="local" className="flex-1">
          Local
        </TabsTrigger>
        <TabsTrigger value="gateway" className="flex-1">
          Gateway
        </TabsTrigger>
        <TabsTrigger value="direct" className="flex-1">
          Direct
        </TabsTrigger>
      </TabsList>
      <TabsContent value="local" className="mt-3">
        <OllamaLocalPath active={tab === 'local'} />
      </TabsContent>
      <TabsContent value="gateway" className="mt-3">
        <OpenRouterGatewayPath />
      </TabsContent>
      <TabsContent value="direct" className="mt-3">
        <DirectProviderPath />
      </TabsContent>
    </Tabs>
  );
}
