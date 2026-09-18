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
import { useEffect, useRef, useState } from 'react';
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

/** The service id a choice submits — a listed one, or `openai` for Other. */
function providerIdFor(choice: SourceChoice): string {
  return entryFor(choice)?.id ?? 'openai';
}

/** The address a listed service answers on when nothing overrides it. */
function defaultBaseURLFor(id: string): string {
  return (
    OPENCODE_DIRECT_PROVIDERS.find((entry) => entry.id === id)?.defaultBaseURL ??
    OPENCODE_DIRECT_PROVIDERS[0].defaultBaseURL
  );
}

/** A saved setup this form owns — its service is one the picker offers. */
type OwnedSetup = OpenCodeDirectSetup & { providerId: string };

/**
 * Whether what is saved belongs to THIS form at all.
 *
 * `runtimes.opencode.provider` is shared with the cloud and on-your-computer
 * paths, so it can read `openrouter` or `ollama` — neither of which this form
 * owns, and whose address (if any) means nothing here. Treating those as
 * "nothing saved" is what stops the form prefilling someone else's settings and
 * offering to overwrite them from a field the person never filled in.
 *
 * @param setup - What the server says is saved.
 */
function ownedSetup(setup: OpenCodeDirectSetup): setup is OwnedSetup {
  return OPENCODE_DIRECT_PROVIDERS.some((entry) => entry.id === setup.providerId);
}

/**
 * Which power source a saved setup means. The rule, in order:
 *
 * 1. Something this form does not own (the cloud or on-your-computer path's
 *    service) is nothing saved here, so the form opens on its default.
 * 2. Anthropic stays Anthropic, custom address or not — it speaks its own
 *    format, so an address cannot turn it into an OpenAI-compatible server.
 * 3. An `openai` connection at OpenAI's own address, or at none at all, is
 *    OpenAI.
 * 4. Anything else is an OpenAI-compatible server DorkOS does not name.
 */
function choiceFor(setup: OpenCodeDirectSetup): SourceChoice {
  if (!ownedSetup(setup)) return 'openai';
  if (setup.providerId === 'anthropic') return 'anthropic';
  if (setup.baseURL === null || setup.baseURL === defaultBaseURLFor(setup.providerId)) {
    return setup.providerId;
  }
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

  // A read that failed is not a read still running. Without this the form sits
  // on its spinner for good, which looks like DorkOS hanging rather than like
  // something a person can retry.
  if (setup.isError && !setup.data) {
    return (
      <ConnectErrorRow
        message="Couldn’t load your saved settings."
        onRetry={() => void setup.refetch()}
      />
    );
  }
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
  // What is saved for ANOTHER path (the cloud or on-your-computer one) is not
  // this form's to prefill from, so it reads as nothing saved here.
  const owned = ownedSetup(setup) ? setup : null;
  const [choice, setChoice] = useState<SourceChoice>(() => choiceFor(setup));
  const [key, setKey] = useState('');
  // A named service fills its own address in, so the field always shows the
  // address DorkOS will actually talk to rather than leaving it to be guessed.
  const [baseURL, setBaseURL] = useState(
    () => owned?.baseURL ?? entryFor(choiceFor(setup))?.defaultBaseURL ?? ''
  );
  // Advanced starts open only when the saved address OVERRIDES the chosen
  // service's own — a service sitting at its own address has nothing to explain.
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    const initial = choiceFor(setup);
    return (
      initial !== OTHER_CHOICE &&
      owned !== null &&
      owned.baseURL !== null &&
      owned.baseURL !== entryFor(initial)?.defaultBaseURL
    );
  });
  const connect = useConnectDirectProvider();
  const test = useCheckProviderCredential();

  const entry = entryFor(choice);
  const providerId = providerIdFor(choice);
  // The saved hint belongs to the saved service. Switch the list to Anthropic
  // while an OpenAI key is saved and there is no saved key for what is on screen.
  const savedLast4 = owned?.key.saved && owned.providerId === providerId ? owned.key.last4 : null;

  const address = baseURL.trim();
  const needsAddress = choice === OTHER_CHOICE;
  const addressReady = !needsAddress || address.length > 0;
  // The address DorkOS would talk to, with the field's own default filled in —
  // the honest thing to compare, warn about, and submit.
  const serviceDefault = defaultBaseURLFor(providerId);
  const effective = address || serviceDefault;
  // Only an address that DIFFERS from the service's own is an override worth
  // storing. `OPENAI_BASE_URL` is set from whatever is stored, so writing
  // Anthropic's own address here would point an OpenAI variable at Anthropic.
  const submittedBaseURL = effective === serviceDefault ? '' : effective;
  // Compare like with like: a saved `null` address means the service's own, so
  // "OpenAI with nothing saved" is not a change when OpenAI is on screen.
  const savedEffective =
    owned === null ? null : (owned.baseURL ?? defaultBaseURLFor(owned.providerId));
  const changed = providerId !== (owned?.providerId ?? null) || effective !== savedEffective;
  const hasKey = key.trim().length > 0;
  // A saved key is only ever sent to the address it is already saved for, so
  // there is nothing honest to do with one at a NEW address. The server enforces
  // this by ignoring a caller's address on that path; the form says why instead
  // of letting someone press a button that quietly does something else.
  const savedKeyUsable = savedLast4 !== null && !changed;
  const canTest = (hasKey || savedKeyUsable) && addressReady;
  // Blank field means "keep what is saved", which is not something to save.
  const canSave = hasKey && addressReady;
  const needsRepaste = !hasKey && savedLast4 !== null && changed;
  const insecure = effective.startsWith('http://');

  const input = { providerId, key, baseURL: submittedBaseURL };
  // Everything is read-only while a check or a save is in flight, but the form
  // STAYS on screen (see the progress row below for why).
  const busy = connect.isPending;
  const keyField = useRef<HTMLInputElement>(null);

  /** Drop a stale answer the moment the thing it was about changes. */
  const invalidateAnswers = () => {
    test.reset();
    connect.reset();
  };

  useEffect(() => {
    if (connect.isSuccess) onConnected?.(DIRECT_CONNECT_SUCCESS);
  }, [connect.isSuccess, onConnected]);

  // Put the cursor back where the fix happens. A refusal is almost always a
  // mistyped key, and the alternative is reading a message and then hunting for
  // the field it is about.
  useEffect(() => {
    if (connect.isError) keyField.current?.focus();
  }, [connect.isError]);

  if (connect.isSuccess) {
    return <ConnectedRow />;
  }

  return (
    <form
      className="space-y-3"
      data-testid="direct-provider"
      onSubmit={(e) => {
        e.preventDefault();
        // One message at a time: a save's answer replaces a test's, rather than
        // both refusals sitting on screen saying the same thing twice.
        test.reset();
        connect.connect(input);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="direct-provider-source" className="text-xs">
          Power source
        </Label>
        <Select
          value={choice}
          disabled={busy}
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
            disabled={busy}
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
          disabled={busy}
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
          ref={keyField}
          value={key}
          disabled={busy}
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
      {needsRepaste && (
        <p className="text-muted-foreground text-xs" data-testid="direct-provider-repaste">
          Paste your key again to change the address.
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        {entry === undefined ? (
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
            disabled={!canTest || busy}
            data-testid="direct-provider-test"
            onClick={() => {
              // One message at a time, in both directions.
              connect.reset();
              test.reset();
              test.check(input);
            }}
          >
            Test key
          </Button>
          <Button type="submit" size="sm" disabled={!canSave || busy}>
            Save & connect
          </Button>
        </div>
      </div>

      {/* One slot for every answer, and the form never leaves the page to show
          one. Swapping the whole form out for a spinner collapsed the panel's
          height, which threw the scroll position to the top — so the refusal
          that came back was off-screen, below a form that looked untouched. */}
      {busy || test.isPending ? (
        <ConnectProgressRow
          message={busy && connect.phase === 'saving' ? 'Saving…' : 'Checking your key…'}
        />
      ) : test.result?.ok === true ? (
        // Say WHICH key works. With a blank field the answer is about the key
        // already saved, and "Key works" would read as being about what is on
        // screen — which is nothing.
        <ConnectedRow message={test.checkedSavedKey ? 'Your saved key works' : 'Key works'} />
      ) : test.result ? (
        // A plain line, not a row with a Retry button: there is nothing to retry
        // blindly. The key is wrong or the address is, and both are fixed in the
        // fields right above before pressing Test again.
        <p className="text-destructive text-xs" role="alert">
          {test.result.message}
        </p>
      ) : null}
    </form>
  );
}
