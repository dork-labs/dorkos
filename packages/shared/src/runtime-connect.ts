/**
 * Runtime connect types — the client-facing shapes for the terminal-free connect
 * surface (ADR-0318, effortless-runtime-switching T1). Each type mirrors a
 * `/api/runtimes/**` connect endpoint's response and is deliberately secret-free:
 * a stored credential is always represented by its REFERENCE (`keychain:`/`env:`/
 * `file:`), never the plaintext, and no connect response ever echoes a secret.
 *
 * @module shared/runtime-connect
 */
import type { ModelTier } from './schemas.js';

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

/** A single pulled Ollama model reported by local detection. */
export interface OllamaModel {
  /** Model tag (e.g. `qwen2.5-coder:7b`). */
  name: string;
  /** On-disk size in bytes, when reported. */
  size?: number;
}

/**
 * An installed Ollama model paired with its honest fit verdict for this machine
 * (spec: opencode-connect-overhaul §3). Derived from Ollama's `/api/tags` list:
 * the tag's on-disk `sizeBytes` is used as the model's resident footprint, run
 * through the same static fit heuristic as the curated catalog.
 */
export interface OllamaInstalledModel {
  /** Ollama model tag (e.g. `qwen2.5-coder:7b`). */
  id: string;
  /** On-disk size in bytes, from Ollama's tag listing. */
  sizeBytes: number;
  /** Static fit verdict for this machine (footprint taken as the on-disk size). */
  assessment: OllamaModelAssessment;
}

/**
 * How DorkOS can install Ollama on this machine without asking for a password
 * (spec §13). `brew` on macOS or `winget` on Windows means a one-click guided
 * install is possible; `manual` means there is no password-free path (Linux, or a
 * machine without a supported package manager), so the client shows the official
 * command to copy instead. DorkOS never runs an install with elevated privileges.
 */
export type OllamaInstallMethod = 'brew' | 'winget' | 'manual';

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
  /**
   * Installed models with an honest fit verdict per model (spec §3). Present only
   * on the detection endpoint's response — the raw probe (`detectOllama`) omits it,
   * and the route assesses the raw `models` against this machine's hardware.
   */
  installed?: OllamaInstalledModel[];
  /**
   * How Ollama can be installed on this machine (spec §13). Present only on the
   * detection endpoint's response so the client can offer a one-click guided
   * install (`brew`/`winget`) or a copyable command (`manual`); the raw probe
   * (`detectOllama`) omits it.
   */
  installMethod?: OllamaInstallMethod;
}

/**
 * Terminal result of a guided Ollama install (spec §13). Mirrors
 * `RuntimeProvisionResult` but carries the resolved {@link OllamaInstallMethod}
 * and a fresh {@link OllamaStatus} re-probe so the client knows, without a second
 * round-trip, whether Ollama is installed AND already running. On failure `error`
 * is an honest, condensed message (never a raw stack) for the Connect surface.
 */
export interface OllamaProvisionResult {
  /** True when the installer completed and Ollama's binary is present. */
  ok: boolean;
  /** The install method that was used (or `manual` when no one-click path exists). */
  installMethod: OllamaInstallMethod;
  /** Honest failure message when not `ok`. */
  error?: string;
  /**
   * A fresh detection re-probe taken after a successful install (and best-effort
   * start). Lets the client distinguish installed-and-running from
   * installed-but-not-running without a second request. Omitted on failure.
   */
  status?: OllamaStatus;
}

/**
 * Syntactic shape of a valid Ollama model tag (`name[:version]`, optionally
 * namespaced like `library/qwen2.5-coder`). Used to validate a pull-by-name
 * request: DorkOS pulls any syntactically valid tag, not just curated ones
 * (spec §3), so this guards against malformed input without gating on the catalog.
 */
export const OLLAMA_TAG_PATTERN = /^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._-]+)?$/i;

/**
 * One curated coding model DorkOS can guide a one-click Ollama pull for
 * (effortless-runtime-switching T2, task 3.5). The list is deliberately tiny and
 * honest — DorkOS offers a couple of sensible defaults, not an open model browser
 * (power users pull anything with Ollama directly). Sizing is approximate and
 * describes the model's default quantized (Q4) build.
 */
export interface OllamaCatalogModel {
  /** Ollama model id/tag to pull (e.g. `qwen2.5-coder:7b`). */
  id: string;
  /** Short human label (e.g. `Qwen2.5 Coder 7B`). */
  label: string;
  /** Approximate parameter count in billions (e.g. `7`). */
  paramsB: number;
  /** Approximate download size in bytes (the default Q4 GGUF build). */
  downloadBytes: number;
  /** Human-readable approximate download size (e.g. `~4.7 GB`). */
  sizeLabel: string;
  /**
   * Approximate memory the model needs resident to run (bytes) — weights plus a
   * modest KV-cache/runtime overhead. Used by the static fit heuristic.
   */
  minMemoryBytes: number;
  /**
   * One honest line on what this model is and is NOT. Never implies a small local
   * model equals a frontier cloud model; tool-calling below ~14B is unreliable.
   */
  note: string;
  /**
   * Coarse capability tier for grouping in the picker. A local model is at most a
   * `solid-coder` or `quick-helper` — never `frontier` (which stays cloud-only).
   * Optional so a synthesized entry for an installed (uncurated) model can omit it.
   */
  tier?: ModelTier;
}

/**
 * Static fit verdict for a curated model against the detected hardware. Honest
 * and coarse by design — an estimate from memory-vs-model-size, never a
 * benchmark and never a certainty.
 */
export type OllamaFitVerdict = 'runs-well' | 'may-be-slow' | 'too-large';

/** A curated model paired with its static fit verdict for the current machine. */
export interface OllamaModelAssessment {
  /** The curated model being assessed. */
  model: OllamaCatalogModel;
  /** Static fit verdict against the detected hardware. */
  verdict: OllamaFitVerdict;
  /** One honest line explaining the verdict; always framed as an estimate. */
  explanation: string;
}

/**
 * Cheaply-detected hardware snapshot the fit heuristic reasons over. Discrete
 * VRAM is not probed (that would mean shelling out to `nvidia-smi` /
 * `system_profiler`), so `vramBytes` is `null` on non-unified machines and the
 * heuristic degrades to RAM-only reasoning — honestly reflected in the copy.
 */
export interface OllamaHardware {
  /** Total system RAM in bytes (from the OS). */
  totalRamBytes: number;
  /** Detected dedicated GPU VRAM in bytes when cheaply known; `null` otherwise. */
  vramBytes: number | null;
  /**
   * True when system RAM is unified with the GPU (Apple Silicon), so the GPU can
   * use a large fraction of RAM via Metal — a cheap, reliable static signal.
   */
  unifiedMemory: boolean;
}

/**
 * The curated coding-model catalog assessed against this machine — the payload
 * behind the guided-pull picker. Carries the detected hardware snapshot plus each
 * curated model's honest fit verdict.
 */
export interface OllamaModelCatalog {
  /** Detected hardware snapshot the verdicts were computed against. */
  hardware: OllamaHardware;
  /** Curated coding models, each with a static fit verdict for this machine. */
  models: OllamaModelAssessment[];
}

/**
 * One progress frame emitted while an Ollama model is being pulled. Mirrors
 * Ollama's own streamed pull status (`status`/`completed`/`total`), plus a
 * convenience `percent` for the current layer.
 */
export interface OllamaPullProgress {
  /** Ollama's raw status line (e.g. `pulling manifest`, `downloading`, `success`). */
  status: string;
  /** Bytes downloaded so far for the current layer, when reported. */
  completed?: number;
  /** Total bytes for the current layer, when reported. */
  total?: number;
  /** Convenience 0–100 percentage for the current layer, when both bounds are known. */
  percent?: number;
}

/**
 * Terminal result of a guided Ollama pull. On success the model is pulled and
 * OpenCode's Local path can connect to it with zero auth; on failure `error`
 * carries an honest, non-raw message for the Connect surface.
 */
export interface OllamaPullResult {
  /** True when the pull completed successfully. */
  ok: boolean;
  /** The model id that was pulled (or attempted). */
  model: string;
  /** Honest failure message when not `ok`. */
  error?: string;
}
