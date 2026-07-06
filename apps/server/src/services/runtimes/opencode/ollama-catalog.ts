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
 * The heuristic is pure and unit-testable; hardware detection is cheap and
 * non-blocking (`os.totalmem()` plus the Apple-Silicon unified-memory signal). We
 * deliberately do NOT probe discrete VRAM — that would mean shelling out to
 * `nvidia-smi` / `system_profiler` — so on non-unified machines `vramBytes` is
 * `null` and the heuristic degrades to RAM-only reasoning, honestly reflected in
 * the copy. Everything here is Ollama-adjacent but the SDK is never touched.
 *
 * @module services/runtimes/opencode/ollama-catalog
 */
import os from 'node:os';
import type {
  OllamaCatalogModel,
  OllamaFitVerdict,
  OllamaHardware,
  OllamaModelAssessment,
  OllamaModelCatalog,
} from '@dorkos/shared/runtime-connect';

/** 1 gibibyte in bytes — the unit sizing is expressed in. */
const GB = 1024 ** 3;

/**
 * The curated coding models offered for a one-click guided pull. Sizes describe
 * each model's default quantized (Q4_K_M) build as Ollama pulls it. Kept honest
 * and small: two sizes of one strong open coding model, with a plain caveat that
 * a small local model is not a frontier cloud model.
 *
 * Reversible: sizes are approximate (Ollama's tags can be re-quantized); if a
 * pulled build's real size drifts, update the metadata here — nothing downstream
 * hard-codes it.
 */
export const OLLAMA_CODING_MODELS: readonly OllamaCatalogModel[] = [
  {
    id: 'qwen2.5-coder:7b',
    label: 'Qwen2.5 Coder 7B',
    paramsB: 7,
    downloadBytes: Math.round(4.7 * GB),
    sizeLabel: '~4.7 GB',
    minMemoryBytes: 8 * GB,
    note: 'Fast and capable for edits and autocomplete; agentic tool-calling is limited — not a substitute for Claude or a frontier cloud model.',
  },
  {
    id: 'qwen2.5-coder:14b',
    label: 'Qwen2.5 Coder 14B',
    paramsB: 14,
    downloadBytes: Math.round(9.0 * GB),
    sizeLabel: '~9.0 GB',
    minMemoryBytes: 16 * GB,
    note: 'The smallest size where multi-step tool-use starts to hold up; still short of a frontier cloud model, but a strong private local option.',
  },
] as const;

/** The default curated model the guided pull uses when the client names none. */
export const DEFAULT_OLLAMA_MODEL_ID = OLLAMA_CODING_MODELS[0].id;

/**
 * Resolve a requested model id to a curated catalog entry, or `null` when it is
 * not one DorkOS guides a pull for. Guards the pull endpoint so only curated
 * coding models can be triggered here (power users use Ollama directly).
 *
 * @param id - The requested Ollama model id/tag.
 */
export function resolveCuratedModel(id: string): OllamaCatalogModel | null {
  return OLLAMA_CODING_MODELS.find((m) => m.id === id) ?? null;
}

/**
 * Cheaply detect the hardware the fit heuristic reasons over. Non-blocking: reads
 * `os.totalmem()` and the Apple-Silicon (unified-memory) static signal only. No
 * discrete-VRAM probe (see the module note), so `vramBytes` stays `null`.
 *
 * @param overrides - Test seam to inject a fixed hardware snapshot.
 */
export function detectHardware(overrides?: Partial<OllamaHardware>): OllamaHardware {
  const unifiedMemory = process.platform === 'darwin' && process.arch === 'arm64';
  return {
    totalRamBytes: os.totalmem(),
    // Discrete VRAM is not cheaply detectable cross-platform without shelling
    // out; degrade to RAM-only reasoning rather than block or guess.
    vramBytes: null,
    unifiedMemory,
    ...overrides,
  };
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

/**
 * Assess the whole curated catalog against this machine — the payload behind the
 * guided-pull picker. Pure over its (optionally injected) hardware snapshot.
 *
 * @param deps - Test seam to inject a fixed hardware snapshot.
 */
export function assessOllamaModels(deps: { hardware?: OllamaHardware } = {}): OllamaModelCatalog {
  const hardware = deps.hardware ?? detectHardware();
  return {
    hardware,
    models: OLLAMA_CODING_MODELS.map((m) => classifyModelFit(m, hardware)),
  };
}
