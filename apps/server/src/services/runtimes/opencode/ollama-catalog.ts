/**
 * Curated coding-model catalog + static hardware-fit heuristic for the guided
 * Ollama pull (effortless-runtime-switching T2, task 3.5).
 *
 * Two honest, deliberately-tiny concerns live here:
 *
 * 1. A curated list of a couple of sensible coding models with HONEST sizing
 *    metadata ({@link OLLAMA_CODING_MODELS}). This is not an open model browser —
 *    the guided pull offers a sensible default; power users pull anything with
 *    Ollama directly.
 * 2. A STATIC fit heuristic ({@link classifyModelFit}) that classifies a model as
 *    `runs-well | may-be-slow | too-large` from available memory vs the model's
 *    footprint, with honest copy. It is intentionally coarse — an estimate from
 *    memory-vs-model-size, never a benchmark, never a certainty. The Open Question
 *    on the heuristic (spec §Open Questions) resolved to "lean static first".
 *
 * The heuristic is pure and unit-testable. The cheap, synchronous
 * {@link detectHardware} reads `os.totalmem()` plus the Apple-Silicon
 * unified-memory signal. On non-Apple-Silicon machines the async
 * {@link detectHardwareAsync} adds a short, best-effort `nvidia-smi` probe for
 * discrete `vramBytes`; if it is absent or slow, we fall back to RAM-only
 * reasoning, honestly reflected in the copy. Everything here is Ollama-adjacent
 * but the SDK is never touched.
 *
 * @module services/runtimes/opencode/ollama-catalog
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type {
  OllamaCatalogModel,
  OllamaFitVerdict,
  OllamaHardware,
  OllamaInstalledModel,
  OllamaModel,
  OllamaModelAssessment,
  OllamaModelCatalog,
} from '@dorkos/shared/runtime-connect';
import { capLocalTier, classifyTier, parseParamsB } from './model-tiers.js';

const execFileAsync = promisify(execFile);

/** 1 gibibyte in bytes — the unit sizing is expressed in. */
const GB = 1024 ** 3;

/**
 * The curated coding models offered for a one-click guided pull. Sizes describe
 * each model's default quantized (Q4_K_M) build as Ollama pulls it, verified
 * against `ollama.com/library`. Kept honest: a handful of strong open coding
 * models spanning tiers, each with a plain caveat that a small local model is not
 * a frontier cloud model. Power users pull anything else with Ollama directly.
 *
 * Reversible: sizes are approximate (Ollama's tags can be re-quantized); if a
 * pulled build's real size drifts, update the metadata here — nothing downstream
 * hard-codes it.
 */
export const OLLAMA_CODING_MODELS: readonly OllamaCatalogModel[] = [
  {
    id: 'qwen2.5-coder:1.5b',
    label: 'Qwen2.5 Coder 1.5B',
    paramsB: 1.5,
    downloadBytes: Math.round(1.0 * GB),
    sizeLabel: '~1.0 GB',
    minMemoryBytes: 4 * GB,
    note: 'Tiny and quick for autocomplete and small edits; not for multi-step work — nowhere near a frontier cloud model.',
    tier: 'quick-helper',
  },
  {
    id: 'qwen2.5-coder:7b',
    label: 'Qwen2.5 Coder 7B',
    paramsB: 7,
    downloadBytes: Math.round(4.7 * GB),
    sizeLabel: '~4.7 GB',
    minMemoryBytes: 8 * GB,
    note: 'Fast and capable for edits and autocomplete; agentic tool-calling is limited — not a substitute for Claude or a frontier cloud model.',
    tier: 'quick-helper',
  },
  {
    id: 'qwen2.5-coder:14b',
    label: 'Qwen2.5 Coder 14B',
    paramsB: 14,
    downloadBytes: Math.round(9.0 * GB),
    sizeLabel: '~9.0 GB',
    minMemoryBytes: 16 * GB,
    note: 'The smallest size where multi-step tool-use starts to hold up; still short of a frontier cloud model, but a strong private local option.',
    tier: 'solid-coder',
  },
  {
    id: 'qwen2.5-coder:32b',
    label: 'Qwen2.5 Coder 32B',
    paramsB: 32,
    downloadBytes: Math.round(20 * GB),
    sizeLabel: '~20 GB',
    minMemoryBytes: 24 * GB,
    note: 'The strongest local coder here, good at multi-step edits; still short of a frontier cloud model, and it needs a lot of memory.',
    tier: 'solid-coder',
  },
  {
    id: 'deepseek-r1:14b',
    label: 'DeepSeek-R1 14B',
    paramsB: 14,
    downloadBytes: Math.round(9.0 * GB),
    sizeLabel: '~9.0 GB',
    minMemoryBytes: 16 * GB,
    note: 'A reasoning-focused model that thinks step by step; capable but slower, and not a match for a frontier cloud model.',
    tier: 'solid-coder',
  },
  {
    id: 'deepseek-coder-v2:16b',
    label: 'DeepSeek-Coder-V2 16B',
    paramsB: 16,
    downloadBytes: Math.round(8.9 * GB),
    sizeLabel: '~8.9 GB',
    minMemoryBytes: 16 * GB,
    note: 'A well-rounded open coding model; solid for everyday edits, but limited on long agentic chains versus a frontier cloud model.',
    tier: 'solid-coder',
  },
] as const;

/**
 * The default curated model the guided pull uses when the client names none — a
 * capable, broadly-runnable pick rather than the tiniest. Guarded to exist in the
 * catalog by the catalog unit test.
 */
export const DEFAULT_OLLAMA_MODEL_ID = 'qwen2.5-coder:7b';

/**
 * Cheaply detect the hardware the fit heuristic reasons over. Non-blocking and
 * synchronous: reads `os.totalmem()` and the Apple-Silicon (unified-memory) static
 * signal only, leaving `vramBytes` `null`. Use {@link detectHardwareAsync} to add
 * the discrete-VRAM probe on non-Apple-Silicon machines.
 *
 * @param overrides - Test seam to inject a fixed hardware snapshot.
 */
export function detectHardware(overrides?: Partial<OllamaHardware>): OllamaHardware {
  const unifiedMemory = process.platform === 'darwin' && process.arch === 'arm64';
  return {
    totalRamBytes: os.totalmem(),
    // Filled in by detectHardwareAsync on non-unified machines; null here.
    vramBytes: null,
    unifiedMemory,
    ...overrides,
  };
}

/** MiB in bytes — `nvidia-smi` reports `memory.total` in MiB with `nounits`. */
const MIB = 1024 * 1024;

/** Bound on the `nvidia-smi` probe so a stalled call can never hang a requirements read. */
const NVIDIA_PROBE_TIMEOUT_MS = 1_500;

/**
 * Parse `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`
 * output (one MiB integer per GPU, one per line) into bytes for the largest GPU,
 * or `null` when nothing parses. Pure and unit-testable.
 *
 * @param stdout - Raw `nvidia-smi` stdout.
 */
export function parseNvidiaVramBytes(stdout: string): number | null {
  const values = stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (values.length === 0) return null;
  return Math.max(...values) * MIB;
}

/**
 * Best-effort discrete-VRAM probe via `nvidia-smi`. Bounded by
 * {@link NVIDIA_PROBE_TIMEOUT_MS}; any failure (binary absent, timeout, unparseable
 * output) resolves to `null` so the heuristic falls back to RAM-only reasoning.
 * No new dependency and no WMI — `nvidia-smi` only.
 */
async function probeNvidiaVramBytes(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: NVIDIA_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' }
    );
    return parseNvidiaVramBytes(stdout);
  } catch {
    // nvidia-smi absent, timed out, or errored — degrade to RAM-only.
    return null;
  }
}

/** Injectable probe seam so tests supply a fixed VRAM snapshot without shelling out. */
export interface HardwareProbeDeps {
  /** Override the discrete-VRAM probe (defaults to the bounded `nvidia-smi` call). */
  probeVram?: () => Promise<number | null>;
}

/**
 * Detect hardware with the discrete-VRAM probe applied. Reads the cheap
 * synchronous snapshot ({@link detectHardware}), then — only when it could matter
 * (not unified memory, and `vramBytes` not already supplied) — runs the bounded
 * `nvidia-smi` probe to fill `vramBytes`. Failure or absence leaves the RAM-only
 * snapshot unchanged.
 *
 * @param overrides - Test seam to inject a fixed hardware snapshot.
 * @param deps - Test seam to inject the VRAM probe.
 */
export async function detectHardwareAsync(
  overrides?: Partial<OllamaHardware>,
  deps: HardwareProbeDeps = {}
): Promise<OllamaHardware> {
  const hardware = detectHardware(overrides);
  if (hardware.vramBytes == null && !hardware.unifiedMemory) {
    const probe = deps.probeVram ?? probeNvidiaVramBytes;
    hardware.vramBytes = await probe();
  }
  return hardware;
}

/** Format a byte count as a rounded `N.N GB` string for honest copy. */
function formatGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/**
 * The memory the model can actually draw on, and whether inference is
 * GPU-accelerated. On Apple Silicon the Metal working set is a large fraction of
 * unified RAM (~70%); with a known discrete VRAM figure, that; otherwise system
 * RAM on CPU/iGPU (no GPU acceleration assumed).
 */
function usableMemory(hw: OllamaHardware): { bytes: number; gpuAccelerated: boolean } {
  if (hw.unifiedMemory) {
    return { bytes: Math.round(hw.totalRamBytes * 0.7), gpuAccelerated: true };
  }
  if (hw.vramBytes != null) {
    return { bytes: hw.vramBytes, gpuAccelerated: true };
  }
  return { bytes: hw.totalRamBytes, gpuAccelerated: false };
}

/** Headroom over a model's footprint before we call the fit comfortable. */
const COMFORTABLE_HEADROOM = 1.5;

/**
 * Classify one curated model's fit against the detected hardware — the pure,
 * static heuristic. Coarse and honest: it compares usable memory to the model's
 * resident footprint and never claims certainty.
 *
 * Boundaries:
 * - usable memory below the model's footprint → `too-large` (likely won't load).
 * - fits but with little headroom → `may-be-slow`.
 * - ample memory but no detected GPU (CPU inference) → `may-be-slow` (honest:
 *   CPU token generation is slow even with plenty of RAM).
 * - ample memory with GPU acceleration → `runs-well`.
 *
 * @param model - The curated model to assess.
 * @param hw - The detected hardware snapshot.
 */
export function classifyModelFit(
  model: OllamaCatalogModel,
  hw: OllamaHardware
): OllamaModelAssessment {
  const { bytes: usable, gpuAccelerated } = usableMemory(hw);
  const need = model.minMemoryBytes;

  let verdict: OllamaFitVerdict;
  let explanation: string;

  if (usable < need) {
    verdict = 'too-large';
    explanation = `Needs about ${formatGb(need)} of memory but your machine has roughly ${formatGb(usable)} available — it likely won't load. An estimate, not a benchmark.`;
  } else if (usable < need * COMFORTABLE_HEADROOM) {
    verdict = 'may-be-slow';
    explanation = `Fits, but with little memory headroom — expect slower responses. An estimate, not a benchmark.`;
  } else if (!gpuAccelerated) {
    verdict = 'may-be-slow';
    explanation = `Enough memory, but no dedicated GPU was detected, so it runs on the CPU — expect slower responses. An estimate, not a benchmark.`;
  } else {
    verdict = 'runs-well';
    explanation = `Comfortable fit for your hardware — it should run smoothly. An estimate, not a benchmark.`;
  }

  return { model, verdict, explanation };
}

/** Seams for the catalog/installed assessment: inject a hardware snapshot or the VRAM probe. */
export interface AssessDeps extends HardwareProbeDeps {
  /** Inject a fixed hardware snapshot (skips detection entirely). */
  hardware?: OllamaHardware;
}

/** Resolve the hardware snapshot for an assessment, detecting (with the VRAM probe) when not injected. */
function resolveHardware(deps: AssessDeps): Promise<OllamaHardware> {
  if (deps.hardware) return Promise.resolve(deps.hardware);
  return detectHardwareAsync(undefined, { probeVram: deps.probeVram });
}

/**
 * Assess the whole curated catalog against this machine — the payload behind the
 * guided-pull picker. Detects hardware (including the discrete-VRAM probe) unless
 * a snapshot is injected.
 *
 * @param deps - Test seams to inject a hardware snapshot or the VRAM probe.
 */
export async function assessOllamaModels(deps: AssessDeps = {}): Promise<OllamaModelCatalog> {
  const hardware = await resolveHardware(deps);
  return {
    hardware,
    models: OLLAMA_CODING_MODELS.map((m) => classifyModelFit(m, hardware)),
  };
}

/**
 * Synthesize a catalog-model shape for an installed (possibly uncurated) Ollama
 * tag so the same fit heuristic can score it. The on-disk size is taken as the
 * model's resident footprint (`minMemoryBytes`); {@link classifyModelFit} applies
 * the comfort headroom. The tier and parameter count are inferred from the tag id.
 *
 * @param id - The installed model tag (e.g. `qwen2.5-coder:7b`).
 * @param sizeBytes - The tag's on-disk size in bytes.
 */
function syntheticCatalogModel(id: string, sizeBytes: number): OllamaCatalogModel {
  // Installed Ollama models are always local — cap the tier below frontier
  // (a local model whose id matches a frontier family is not a frontier model).
  const tier = capLocalTier(id, classifyTier(id));
  return {
    id,
    label: id,
    paramsB: parseParamsB(id) ?? 0,
    downloadBytes: sizeBytes,
    sizeLabel: `~${formatGb(sizeBytes)}`,
    // Footprint ≈ on-disk size; classifyModelFit applies the 1.5× comfort headroom.
    minMemoryBytes: sizeBytes,
    note: 'A model you already pulled with Ollama. It runs entirely on this computer.',
    ...(tier ? { tier } : {}),
  };
}

/**
 * Assess the models a user has already pulled (from Ollama's `/api/tags`) against
 * this machine — each with an honest fit verdict (spec §3). Models with no known
 * on-disk size are skipped (their fit cannot be judged). Detects hardware unless a
 * snapshot is injected.
 *
 * @param models - The installed models reported by local detection.
 * @param deps - Test seams to inject a hardware snapshot or the VRAM probe.
 */
export async function assessInstalledModels(
  models: OllamaModel[],
  deps: AssessDeps = {}
): Promise<OllamaInstalledModel[]> {
  const hardware = await resolveHardware(deps);
  const installed: OllamaInstalledModel[] = [];
  for (const model of models) {
    if (typeof model.size !== 'number' || model.size <= 0) continue;
    const synthetic = syntheticCatalogModel(model.name, model.size);
    installed.push({
      id: model.name,
      sizeBytes: model.size,
      assessment: classifyModelFit(synthetic, hardware),
    });
  }
  return installed;
}
