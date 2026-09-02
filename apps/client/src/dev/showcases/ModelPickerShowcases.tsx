/**
 * The model picker — the panel behind the model name in the status line.
 *
 * It is here because it is the one panel in the app that has to draw a
 * stranger's catalog. Claude Code offers a few models with names like "Opus";
 * OpenRouter offers hundreds, with ids namespaced two levels deep and rows that
 * have to admit what the model cannot do. The second case is what set the
 * panel's width and its per-line overflow rules (DOR-1673), and neither is
 * visible in the first.
 *
 * Every demo opens the REAL `ModelConfigPopover` — the same component the status
 * line mounts, at the same width, with the same chrome — by handing it a
 * catalog through a transport rather than by rebuilding its panel. The catalogs
 * are fixtures (`model-picker-showcase-data.ts`); reaching a live OpenRouter
 * list needs a connected provider, which a playground does not have.
 *
 * @module dev/showcases/ModelPickerShowcases
 */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ModelOption } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { ModelConfigPopover } from '@/layers/features/status';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import {
  CLAUDE_CODE_CATALOG,
  OPENCODE_CATALOG,
  UNVERIFIED_CATALOG,
} from './model-picker-showcase-data';

/**
 * The playground transport with one method answered: the model catalog.
 *
 * Scoped to this showcase rather than added to `createPlaygroundTransport`,
 * because `getModels` is read by the context-health and session-status hooks
 * too — giving every showcase in the playground a catalog would quietly change
 * demos that have nothing to do with this one.
 *
 * @param models - The catalog `getModels` should answer with.
 */
function catalogTransport(models: ModelOption[]): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) =>
      prop === 'getModels' ? async () => models : (Reflect.get(target, prop, receiver) as unknown),
  });
}

/**
 * One picker, opened over a catalog, with its own query cache so two demos on
 * the page cannot serve each other's models.
 *
 * @param props - The catalog to offer and the model that starts selected.
 */
function PickerDemo({ models, selected }: { models: ModelOption[]; selected: string }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [transport] = useState(() => catalogTransport(models));
  const [model, setModel] = useState(selected);

  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        {/* The status line's own type scale, so the trigger reads at the size it
            really does rather than at the playground's body size. */}
        <div className="text-muted-foreground flex items-center text-xs">
          <ModelConfigPopover
            model={model}
            onChangeModel={setModel}
            effort={null}
            onChangeEffort={() => {}}
            fastMode={false}
            onChangeFastMode={() => {}}
          />
        </div>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Model picker showcases for the dev playground. */
export function ModelPickerShowcases() {
  return (
    <PlaygroundSection
      title="Model picker"
      description="Click a model name to open the real panel. On desktop it opens at the width the panel picks for itself; on a phone-sized window it becomes a full-width sheet — resize the browser window itself to see the second one, not the demo's viewport buttons, because the switch is a media query."
    >
      <ShowcaseLabel>
        OpenCode — long ids, a local tag, and rows that admit their limits
      </ShowcaseLabel>
      <ShowcaseDemo>
        <PickerDemo models={OPENCODE_CATALOG} selected="openrouter/google/gemini-3-pro-image" />
      </ShowcaseDemo>

      <ShowcaseLabel>Nothing connected — a short list nobody has confirmed</ShowcaseLabel>
      <ShowcaseDemo>
        <PickerDemo models={UNVERIFIED_CATALOG} selected="openrouter/anthropic/claude-sonnet-4.5" />
      </ShowcaseDemo>

      <ShowcaseLabel>The saved model is gone</ShowcaseLabel>
      <ShowcaseDemo>
        <PickerDemo
          models={OPENCODE_CATALOG}
          selected="openrouter/meta-llama/llama-3.1-nemotron-ultra-253b-v1-free-preview"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Claude Code — three short names in a tiered menu</ShowcaseLabel>
      <ShowcaseDemo>
        <PickerDemo models={CLAUDE_CODE_CATALOG} selected="claude-opus-4-6" />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
