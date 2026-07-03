/**
 * Runtime connect types — the client-facing shapes for the terminal-free connect
 * surface (ADR-0318, effortless-runtime-switching T1). Each type mirrors a
 * `/api/runtimes/**` connect endpoint's response and is deliberately secret-free:
 * a stored credential is always represented by its REFERENCE (`keychain:`/`env:`/
 * `file:`), never the plaintext, and no connect response ever echoes a secret.
 *
 * @module shared/runtime-connect
 */

/**
 * Result of storing a runtime credential (native paste-key path). Carries only
 * the stored REFERENCE — never the secret — so the client can display "connected"
 * without ever holding plaintext.
 */
export interface StoreCredentialResult {
  /**
   * The stored credential reference (`file:<name>`), never the secret itself, or
   * `null` when the credential lives in the runtime's own auth store rather than
   * DorkOS (e.g. Codex writes the key to `$CODEX_HOME/auth.json`, so DorkOS holds
   * no reference).
   */
  ref: string | null;
}

/**
 * Result of a delegated vendor login (`claude auth login` / `codex login`). The
 * login is bounded by a timeout server-side; a hung login resolves to
 * `{ ok: false }` with an honest message rather than blocking forever.
 */
export interface DelegatedLoginResult {
  /** True when the vendor CLI reported a completed, authenticated login. */
  ok: boolean;
  /** Honest failure message when the login failed, was denied, or timed out. */
  error?: string;
}

/**
 * Result of storing/validating an OpenRouter API key (the always-available
 * Gateway paste-key path). The key is validated against OpenRouter before it is
 * stored; the response never echoes the key.
 */
export interface OpenRouterKeyResult {
  /** True when the key validated and was stored as a reference. */
  ok: boolean;
  /** Honest failure message when the key was invalid or could not be stored. */
  error?: string;
}

/**
 * Start payload for the OpenRouter OAuth-PKCE flow. The client opens
 * {@link authorizeUrl} in a browser and polls the flow status keyed by
 * {@link state}; the `code_verifier` never leaves the server.
 */
export interface OpenRouterOAuthStart {
  /** OpenRouter `/auth` URL to open in the user's browser (loopback callback embedded). */
  authorizeUrl: string;
  /** Opaque flow id the client polls for completion; validated by the loopback callback. */
  state: string;
}

/**
 * Status of an in-flight OpenRouter OAuth-PKCE flow, polled by the client after
 * it opens the authorize URL. `connected` once the loopback callback exchanged
 * the code for a scoped key and stored it as a reference.
 */
export interface OpenRouterOAuthStatus {
  /** `pending` while awaiting the browser callback, `connected` on success, `error` on failure/denial. */
  status: 'pending' | 'connected' | 'error';
  /** Honest failure message when `status` is `error`. */
  error?: string;
}

/** A single model from the OpenRouter catalog, mapped for the client model picker. */
export interface OpenRouterModel {
  /** Provider-qualified model id (e.g. `anthropic/claude-3.5-sonnet`). */
  id: string;
  /** Human-readable model name. */
  name: string;
  /** Optional context window in tokens, when the catalog reports it. */
  contextLength?: number;
}

/** A single pulled Ollama model reported by local detection. */
export interface OllamaModel {
  /** Model tag (e.g. `qwen2.5-coder:7b`). */
  name: string;
  /** On-disk size in bytes, when reported. */
  size?: number;
}

/**
 * Result of zero-auth local Ollama detection. `running` reflects whether the
 * local Ollama HTTP API answered within the bounded probe; `models` lists the
 * pulled models (empty when none or when Ollama is absent).
 */
export interface OllamaStatus {
  /** True when the local Ollama HTTP API answered the bounded probe. */
  running: boolean;
  /** Pulled models reported by Ollama; empty when absent or none pulled. */
  models: OllamaModel[];
}
