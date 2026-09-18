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
 * What the person picked in the power-source list: a listed service's own id, or
 * {@link OTHER_CHOICE}.
 *
 * Not a hand-written union, because the list is rendered from
 * {@link OPENCODE_DIRECT_PROVIDERS} — adding a service there adds it here, with
 * nothing to keep in step.
 */
type SourceChoice = string;

/**
 * The choice for an OpenAI-compatible server DorkOS does not name. It submits
 * `openai` with a REQUIRED address, because an OpenAI-compatible server speaks
 * the OpenAI wire format by definition and the address is the only thing that
 * identifies it.
 */
const OTHER_CHOICE = 'other';

/** The listed service a choice refers to, or `undefined` for {@link OTHER_CHOICE}. */
function entryFor(choice: SourceChoice) {
  return OPENCODE_DIRECT_PROVIDERS.find((entry) => entry.id === choice);
}

/** The id a choice submits — a listed service's wire id, or `openai` for Other. */
function wireIdFor(choice: SourceChoice): string {
  return entryFor(choice)?.wireId ?? 'openai';
}

/** The address the wire service answers on when nothing overrides it. */
function wireDefaultBaseURL(wireId: string): string {
  return (
    OPENCODE_DIRECT_PROVIDERS.find((entry) => entry.id === wireId)?.defaultBaseURL ??
    OPENCODE_DIRECT_PROVIDERS[0].defaultBaseURL
  );
}

/**
 * Which power source a saved setup means.
 *
 * Saved config only records the WIRE id and an address, so the address is what
 * tells two services on the same wire apart. The rule, in order:
 *
 * 1. Anthropic is its own wire, so a saved `anthropic` is always Anthropic —
 *    including with a custom address, which stays an Anthropic connection
 *    rather than being re-read as an OpenAI-compatible one.
 * 2. An address that exactly matches a listed service's own is that service,
 *    which is how two services sharing one wire are told apart.
 * 3. No address at all is the plain wire service (`openai` → OpenAI).
 * 4. Anything else is an OpenAI-compatible server DorkOS does not name.
 */
function choiceFor(setup: OpenCodeDirectSetup): SourceChoice {
  if (setup.providerId === 'anthropic') return 'anthropic';
  const named = OPENCODE_DIRECT_PROVIDERS.find(
    (entry) => entry.wireId === setup.providerId && entry.defaultBaseURL === setup.baseURL
  );
  if (named) return named.id;
  if (setup.baseURL === null) return 'openai';
  return OTHER_CHOICE;
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
  // A named service fills its own address in, so the field always shows the
  // address DorkOS will actually talk to rather than leaving it to be guessed.
  const [baseURL, setBaseURL] = useState(
    () => setup.baseURL ?? entryFor(choiceFor(setup))?.defaultBaseURL ?? ''
  );
  // Advanced starts open only when the saved address OVERRIDES the chosen
  // service's own — a service sitting at its own address has nothing to explain.
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    const initial = choiceFor(setup);
    return (
      initial !== OTHER_CHOICE &&
      setup.baseURL !== null &&
      setup.baseURL !== entryFor(initial)?.defaultBaseURL
    );
  });
  const connect = useConnectDirectProvider();
  const test = useCheckProviderCredential();

  const entry = entryFor(choice);
  const wireId = wireIdFor(choice);
  // The saved hint belongs to the saved service. Switch the list to Anthropic
  // while an OpenAI key is saved and there is no saved key for what is on screen.
  const savedLast4 = setup.key.saved && setup.providerId === wireId ? setup.key.last4 : null;

  const address = baseURL.trim();
  const needsAddress = choice === OTHER_CHOICE;
  const addressReady = !needsAddress || address.length > 0;
  // The address DorkOS would talk to, with the field's own default filled in —
  // the honest thing to compare, warn about, and submit.
  const wireDefault = wireDefaultBaseURL(wireId);
  const effective = address || wireDefault;
  // Only an address that DIFFERS from the wire service's own is an override
  // worth storing. `OPENAI_BASE_URL` is set from whatever is stored, so writing
  // Anthropic's own address here would point an OpenAI variable at Anthropic.
  const submittedBaseURL = effective === wireDefault ? '' : effective;
  // Compare like with like: a saved `null` address means the wire service's own,
  // so "OpenAI with nothing saved" is not a change when OpenAI is on screen.
  const savedEffective =
    setup.providerId === null ? null : (setup.baseURL ?? wireDefaultBaseURL(setup.providerId));
  const changed = wireId !== setup.providerId || effective !== savedEffective;
  const hasKey = key.trim().length > 0;
  const canTest = (hasKey || savedLast4 !== null) && addressReady;
  const canSave = (hasKey || (savedLast4 !== null && changed)) && addressReady;
  const insecure = effective.startsWith('http://');

  const input = { providerId: wireId, key, baseURL: submittedBaseURL };

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
            setChoice(value);
            // Picking a named service fills in its address, so nobody has to know
            // one to use it. Advanced still shows the value and still overrides it.
            // Picking Other CLEARS it instead: carrying the last service's address
            // into "not that service" would both look wrong and quietly satisfy
            // the address this choice is supposed to insist on.
            setBaseURL(entryFor(value)?.defaultBaseURL ?? '');
            invalidateAnswers();
          }}
        >
          <SelectTrigger id="direct-provider-source" data-testid="direct-provider-source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPENCODE_DIRECT_PROVIDERS.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
            <SelectItem value={OTHER_CHOICE}>Other (OpenAI-compatible)</SelectItem>
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
      {/* Shown whether or not the address field is on screen: a service that
          happens to sit on plain http is exactly the case where nobody opened
          Advanced, and it is the case they most need to be told about. */}
      {insecure && (
        <p className="text-muted-foreground text-xs" data-testid="direct-provider-insecure">
          This address isn’t encrypted. Your key travels in the open.
        </p>
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
              ? (entry?.keyPlaceholder ?? OPENCODE_DIRECT_PROVIDERS[0].keyPlaceholder)
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
        {entry?.getKeyUrl === undefined ? (
          <span />
        ) : (
          <a
            href={entry.getKeyUrl}
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
