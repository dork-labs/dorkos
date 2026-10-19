/**
 * How an agent computer pays for models (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md` §5), said once.
 *
 * OpenCode is the only runtime there, and it runs on DorkOS credits only:
 * "Runs on" is fixed and cannot be switched (`openCodeRunsOnCredits`, and
 * every settings write is refused on this role anyway). The token is minted
 * by the computer itself, with its own instance key
 * (`./instance-key.ts`), through the same mint-and-renew loop a person's
 * computer uses (`core/cloud/credits-inference.ts`, its credential chosen by
 * `core/cloud/credits-credential.ts`). There is no other way to pay: the
 * sidecar is booted with the credits provider as the only one enabled, and
 * the person-side keys (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, a sign-in)
 * are never handed to it (`runtimes/opencode/credits-sidecar.ts`).
 *
 * With no token, a turn is refused with {@link AGENT_COMPUTER_MODELS_REFUSAL}
 * and nothing is sent.
 *
 * **What the sidecar holds: the relay grant, and why it is not a file.** The
 * sidecar never sees the instance key or a model token. It gets one thing: a
 * key for the loopback credits relay (`core/cloud/credits-relay.ts`), drawn
 * fresh for each sidecar boot and revoked when that boot ends, carried in the
 * config DorkOS hands the sidecar (`OPENCODE_CONFIG_CONTENT`). Moving it into
 * a file would protect nothing: the sidecar must read it, and it runs the
 * agents' tools, so anything it can read an agent can too (on the image it
 * must run as the agents' user; see `./instance-key.ts` for what is not built
 * yet). What protects it instead: it opens only the relay, which
 * listens on 127.0.0.1 alone, answers local programs only, and forwards to
 * the credits endpoint and nowhere else; it is worthless off the computer; it
 * dies with the boot. What keeps it from the server's own secrets is the user
 * split the image provides (`./instance-key.ts`).
 *
 * **Who a token is for.** The mint's optional `agentRef` is attribution only
 * (`packages/cloud-api/src/inference.ts`). The computer mints ONE token, held
 * by DorkOS and added to every request by the credits relay, for the one
 * OpenCode sidecar that serves every agent on the computer, so no single
 * agent is behind it and the mint names none. Attribution per agent waits for
 * a token per agent, which the relay would have to choose per request.
 *
 * @module services/core/agent-computer/models
 */

/** The sentence a turn on an agent computer ends with when it cannot reach models. */
export const AGENT_COMPUTER_MODELS_REFUSAL = "This cloud computer can't reach models right now.";

/**
 * How long an agent computer asks for no new token after the service refused
 * one (a mint answered with a 4xx) or the endpoint refused the held one
 * (401, 402, 403): fifteen minutes, the same hold a beat's check keeps
 * (`services/decisions/triage-credits.ts`, `REFUSED_HOLD_MS`). A hub sends
 * turns without a person in the loop, so without it every turn would ask
 * again for a token the service has just said no to.
 */
export const AGENT_COMPUTER_REFUSAL_HOLD_MS = 15 * 60 * 1000;
