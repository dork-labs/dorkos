/**
 * OpenCode "bring your own key" path (ADR-0318, T1 task 2.8; reworked for
 * DOR-2123 after report FB-48).
 *
 * Three things the person asked for, all here: the key is tried against its own
 * service before anything is saved, a Test button tries it on demand, and
 * reopening the form shows what was entered last time — the power source, the
 * base URL, and a saved key as "ends in ab12" rather than an empty field that
 * reads as "nothing is connected".
 *
 * The source is a short list, not a free-text box. A typed-in name nobody serves
 * used to save cleanly and then fail on the first turn with no key mapping at
 * all; the list and the server's allow-list are now the same list
 * ({@link OPENCODE_DIRECT_PROVIDERS}), so the form cannot offer what the server
 * would refuse. "Other" is the escape hatch for any OpenAI-compatible server,
 * and it requires an address because that is the only thing that identifies it.
 *
 * The key is a password field and unmounts on success — never echoed.
 *
 * @module features/runtime-connect/ui/DirectProviderPath
 */
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  OPENCODE_DIRECT_PROVIDERS,
  type OpenCodeDirectSetup,
} from '@dorkos/shared/runtime-connect';
import {
  Button,
  Input,
  Label,
  PasswordInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import type { RuntimeConnectSuccess } from '@/layers/entities/runtime';
import {
  useCheckProviderCredential,
  useConnectDirectProvider,
  useOpenCodeDirectSetup,
} from '../model/use-opencode-provider';
import { DIRECT_CONNECT_SUCCESS } from '../lib/connect-success';
import { ConnectErrorRow, ConnectProgressRow, ConnectedRow } from './connect-feedback';

/**
 * What the person picked in the power-source list. `other` is a CLIENT-side
 * choice that submits `openai` with a required address, because an
 * OpenAI-compatible server speaks the OpenAI wire format by definition.
 */
type SourceChoice = 'openai' | 'anthropic' | 'other';

/** The service id a choice submits. */
function providerIdFor(choice: SourceChoice): string {
  return choice === 'anthropic' ? 'anthropic' : 'openai';
}

/** The shared entry describing a choice's placeholder, address, and key link. */
function specFor(choice: SourceChoice) {
  const id = providerIdFor(choice);
  return OPENCODE_DIRECT_PROVIDERS.find((entry) => entry.id === id) ?? OPENCODE_DIRECT_PROVIDERS[0];
}

/**
 * Which power source a saved setup means. A saved `openai` pointing somewhere
 * other than OpenAI's own address is an OpenAI-compatible server, so it reopens
 * as "Other" rather than silently claiming to be OpenAI.
 */
function choiceFor(setup: OpenCodeDirectSetup): SourceChoice {
  if (setup.providerId === 'anthropic') return 'anthropic';
  const openai = OPENCODE_DIRECT_PROVIDERS[0];
  if (setup.providerId === 'openai' && setup.baseURL && setup.baseURL !== openai.defaultBaseURL) {
    return 'other';
  }
  return 'openai';
}

/** The "bring your own key" connect path: power source + key + optional address. */
export function DirectProviderPath({
  onConnected,
}: {
  /** Reports the connect landing so the dialog can show its success moment. */
  onConnected?: (success: RuntimeConnectSuccess) => void;
}) {
  const setup = useOpenCodeDirectSetup();

  // Never flash empty fields at someone who HAS saved something — the whole
  // complaint was a form that looked blank when it was not.
  if (!setup.data) {
    return <ConnectProgressRow message="Loading what you saved…" />;
  }
  // Keyed on what came back, so the fields below start from the saved values
  // rather than being patched into place by an effect after first paint.
  return (
    <DirectProviderForm
      key={`${setup.data.providerId ?? ''}|${setup.data.baseURL ?? ''}`}
      setup={setup.data}
      onConnected={onConnected}
    />
  );
}

/** The form itself, mounted once the saved setup is known. */
function DirectProviderForm({
  setup,
  onConnected,
}: {
  /** What is already saved — the starting values for every field. */
  setup: OpenCodeDirectSetup;
  /** Reports the connect landing so the dialog can show its success moment. */
  onConnected?: (success: RuntimeConnectSuccess) => void;
}) {
  const [choice, setChoice] = useState<SourceChoice>(() => choiceFor(setup));
  const [key, setKey] = useState('');
  const [baseURL, setBaseURL] = useState(setup.baseURL ?? '');
  // Advanced starts open only when there is already an address to see there.
  const [advancedOpen, setAdvancedOpen] = useState(
    () => choiceFor(setup) !== 'other' && Boolean(setup.baseURL)
  );
  const connect = useConnectDirectProvider();
  const test = useCheckProviderCredential();

  const spec = specFor(choice);
  const providerId = providerIdFor(choice);
  // The saved hint belongs to the saved service. Switch the list to Anthropic
  // while an OpenAI key is saved and there is no saved key for what is on screen.
  const savedLast4 = setup.key.saved && setup.providerId === providerId ? setup.key.last4 : null;

  const address = baseURL.trim();
  const needsAddress = choice === 'other';
  const addressReady = !needsAddress || address.length > 0;
  const changed = providerId !== setup.providerId || (address || null) !== setup.baseURL;
  const hasKey = key.trim().length > 0;
  const canTest = (hasKey || savedLast4 !== null) && addressReady;
  const canSave = (hasKey || (savedLast4 !== null && changed)) && addressReady;

  const input = { providerId, key, baseURL: address };

  /** Drop a stale answer the moment the thing it was about changes. */
  const invalidateAnswers = () => {
    test.reset();
    connect.reset();
  };

  useEffect(() => {
    if (connect.isSuccess) onConnected?.(DIRECT_CONNECT_SUCCESS);
  }, [connect.isSuccess, onConnected]);

  if (connect.isPending) {
    return (
      <ConnectProgressRow message={connect.phase === 'saving' ? 'Saving…' : 'Checking your key…'} />
    );
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
        connect.connect(input);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="direct-provider-source" className="text-xs">
          Power source
        </Label>
        <Select
          value={choice}
          onValueChange={(value) => {
            setChoice(value as SourceChoice);
            invalidateAnswers();
          }}
        >
          <SelectTrigger id="direct-provider-source" data-testid="direct-provider-source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI</SelectItem>
            <SelectItem value="anthropic">Anthropic</SelectItem>
            <SelectItem value="other">Other (OpenAI-compatible)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {(needsAddress || advancedOpen) && (
        <div className="space-y-1.5">
          <Label htmlFor="direct-provider-base-url" className="text-xs">
            Base URL {!needsAddress && <span className="text-muted-foreground">(optional)</span>}
          </Label>
          <Input
            id="direct-provider-base-url"
            value={baseURL}
            onChange={(e) => {
              setBaseURL(e.target.value);
              invalidateAnswers();
            }}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      {!needsAddress && !advancedOpen && (
        <button
          type="button"
          onClick={() => setAdvancedOpen(true)}
          data-testid="direct-provider-advanced"
          className="text-muted-foreground hover:text-foreground text-xs underline decoration-dotted underline-offset-2 transition-colors"
        >
          Advanced
        </button>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="direct-provider-key" className="text-xs">
          API key
        </Label>
        <PasswordInput
          id="direct-provider-key"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            invalidateAnswers();
          }}
          placeholder={
            savedLast4 === null
              ? spec.keyPlaceholder
              : `Saved · ends in ${savedLast4} — paste a new key to replace it`
          }
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {connect.isError && (
        <p className="text-destructive text-xs" role="alert">
          {connect.errorMessage}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        {needsAddress ? (
          <span />
        ) : (
          <a
            href={spec.getKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
          >
            Get an API key <ExternalLink className="size-3" />
          </a>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canTest}
            data-testid="direct-provider-test"
            onClick={() => {
              connect.reset();
              test.check(input);
            }}
          >
            Test key
          </Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            Save & connect
          </Button>
        </div>
      </div>

      {test.isPending ? (
        <ConnectProgressRow message="Checking your key…" />
      ) : test.result?.ok === true ? (
        <ConnectedRow message="Key works" />
      ) : test.result ? (
        <ConnectErrorRow message={test.result.message} onRetry={() => test.check(input)} />
      ) : null}
    </form>
  );
}
