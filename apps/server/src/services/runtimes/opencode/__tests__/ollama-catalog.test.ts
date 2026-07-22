import { describe, it, expect } from 'vitest';
import type { OllamaHardware, OllamaModel } from '@dorkos/shared/runtime-connect';
import {
  OLLAMA_CODING_MODELS,
  DEFAULT_OLLAMA_MODEL_ID,
  detectHardware,
  detectHardwareAsync,
  parseNvidiaVramBytes,
  classifyModelFit,
  assessInstalledModels,
  assessOllamaModels,
} from '../ollama-catalog.js';

const GB = 1024 ** 3;
const MIB = 1024 * 1024;

/** Build a hardware snapshot for a table-test row. */
function hw(overrides: Partial<OllamaHardware>): OllamaHardware {
  return { totalRamBytes: 16 * GB, vramBytes: null, unifiedMemory: false, ...overrides };
}

const MODEL_7B = OLLAMA_CODING_MODELS.find((m) => m.id === 'qwen2.5-coder:7b')!;
const MODEL_14B = OLLAMA_CODING_MODELS.find((m) => m.id === 'qwen2.5-coder:14b')!;

describe('curated Ollama coding catalog', () => {
  it('is a small honest shelf spanning tiers, never overselling a local model', () => {
    // A handful of curated options across tiers, not an open browser.
    expect(OLLAMA_CODING_MODELS.length).toBeGreaterThanOrEqual(4);
    expect(OLLAMA_CODING_MODELS.length).toBeLessThanOrEqual(8);
    for (const model of OLLAMA_CODING_MODELS) {
      expect(model.sizeLabel).toMatch(/GB/);
      expect(model.downloadBytes).toBeGreaterThan(0);
      expect(model.minMemoryBytes).toBeGreaterThan(0);
      // Every curated entry carries a coarse tier for the picker.
      expect(['frontier', 'solid-coder', 'quick-helper']).toContain(model.tier);
      // A local model is never a frontier headliner.
      expect(model.tier).not.toBe('frontier');
      // Honest capability caveat: never implies frontier/Claude equivalence.
      expect(model.note.toLowerCase()).toMatch(/not|limited|short of|frontier|nowhere near/);
    }
  });

  it('exposes a default that is one of the curated models', () => {
    expect(OLLAMA_CODING_MODELS.some((m) => m.id === DEFAULT_OLLAMA_MODEL_ID)).toBe(true);
  });
});

describe('detectHardware', () => {
  it('reports real total RAM and degrades VRAM to null (no discrete probe)', () => {
    const detected = detectHardware();
    expect(detected.totalRamBytes).toBeGreaterThan(0);
    expect(detected.vramBytes).toBeNull();
    expect(typeof detected.unifiedMemory).toBe('boolean');
  });

  it('honors injected overrides for deterministic assessment', () => {
    const detected = detectHardware({ totalRamBytes: 99 * GB, unifiedMemory: true });
    expect(detected.totalRamBytes).toBe(99 * GB);
    expect(detected.unifiedMemory).toBe(true);
  });
});

describe('classifyModelFit (static hardware heuristic)', () => {
  it('a small model on ample unified RAM → runs-well', () => {
    const result = classifyModelFit(MODEL_7B, hw({ totalRamBytes: 32 * GB, unifiedMemory: true }));
    expect(result.verdict).toBe('runs-well');
    expect(result.explanation).toMatch(/estimate, not a benchmark/i);
  });

  it('a large model on little RAM (no GPU) → too-large', () => {
    const result = classifyModelFit(MODEL_14B, hw({ totalRamBytes: 8 * GB, unifiedMemory: false }));
    expect(result.verdict).toBe('too-large');
    expect(result.explanation).toMatch(/won't load/i);
  });

  it('a model that fits with little headroom → may-be-slow', () => {
    // 7B needs ~8 GB; unified 16 GB → usable ~11.2 GB: fits, below the comfort margin.
    const result = classifyModelFit(MODEL_7B, hw({ totalRamBytes: 16 * GB, unifiedMemory: true }));
    expect(result.verdict).toBe('may-be-slow');
    expect(result.explanation).toMatch(/headroom/i);
  });

  it('ample RAM but no detected GPU (CPU inference) → may-be-slow', () => {
    const result = classifyModelFit(
      MODEL_14B,
      hw({ totalRamBytes: 64 * GB, vramBytes: null, unifiedMemory: false })
    );
    expect(result.verdict).toBe('may-be-slow');
    expect(result.explanation).toMatch(/CPU/i);
  });

  it('a discrete GPU with ample VRAM → runs-well', () => {
    const result = classifyModelFit(
      MODEL_14B,
      hw({ totalRamBytes: 32 * GB, vramBytes: 24 * GB, unifiedMemory: false })
    );
    expect(result.verdict).toBe('runs-well');
  });

  it('never claims certainty (every explanation is framed as an estimate)', () => {
    const machines: OllamaHardware[] = [
      hw({ totalRamBytes: 4 * GB }),
      hw({ totalRamBytes: 16 * GB, unifiedMemory: true }),
      hw({ totalRamBytes: 128 * GB, vramBytes: 80 * GB }),
    ];
    for (const machine of machines) {
      for (const model of OLLAMA_CODING_MODELS) {
        expect(classifyModelFit(model, machine).explanation).toMatch(/estimate/i);
      }
    }
  });
});

describe('assessOllamaModels', () => {
  it('assesses every curated model against the injected hardware', async () => {
    const catalog = await assessOllamaModels({
      hardware: hw({ totalRamBytes: 2 * GB, unifiedMemory: false }),
    });
    expect(catalog.hardware.totalRamBytes).toBe(2 * GB);
    expect(catalog.models).toHaveLength(OLLAMA_CODING_MODELS.length);
    // 2 GB is below every curated model's footprint → all too-large.
    expect(catalog.models.every((m) => m.verdict === 'too-large')).toBe(true);
  });

  it('falls back to hardware detection (with the injected VRAM probe) when none is passed', async () => {
    const catalog = await assessOllamaModels({ probeVram: async () => null });
    expect(catalog.hardware.totalRamBytes).toBeGreaterThan(0);
    expect(catalog.models).toHaveLength(OLLAMA_CODING_MODELS.length);
  });
});

describe('parseNvidiaVramBytes', () => {
  it('returns the largest GPU in bytes from nvidia-smi output', () => {
    // Two GPUs reported in MiB (one per line) → the larger, in bytes.
    expect(parseNvidiaVramBytes('8192\n24576\n')).toBe(24576 * MIB);
    expect(parseNvidiaVramBytes('16384')).toBe(16384 * MIB);
  });

  it('returns null when nothing parses', () => {
    expect(parseNvidiaVramBytes('')).toBeNull();
    expect(parseNvidiaVramBytes('\n\n')).toBeNull();
    expect(parseNvidiaVramBytes('No devices were found')).toBeNull();
  });
});

describe('detectHardwareAsync (GPU probe)', () => {
  it('fills vramBytes from a successful probe on a non-unified machine', async () => {
    const detected = await detectHardwareAsync(
      { totalRamBytes: 32 * GB, unifiedMemory: false },
      { probeVram: async () => 24 * GB }
    );
    expect(detected.vramBytes).toBe(24 * GB);
  });

  it('degrades to RAM-only (vram null) when the probe finds no GPU — a timeout or an absent binary both resolve to null inside the real probe', async () => {
    const detected = await detectHardwareAsync(
      { totalRamBytes: 32 * GB, unifiedMemory: false },
      { probeVram: async () => null }
    );
    expect(detected.vramBytes).toBeNull();
  });

  it('skips the probe entirely on Apple-Silicon unified memory', async () => {
    let probed = false;
    const detected = await detectHardwareAsync(
      { totalRamBytes: 32 * GB, unifiedMemory: true },
      {
        probeVram: async () => {
          probed = true;
          return 24 * GB;
        },
      }
    );
    expect(probed).toBe(false);
    expect(detected.vramBytes).toBeNull();
    expect(detected.unifiedMemory).toBe(true);
  });
});

describe('assessInstalledModels', () => {
  const installed: OllamaModel[] = [
    { name: 'qwen2.5-coder:7b', size: 4.7 * GB },
    { name: 'deepseek-coder-v2:16b', size: 8.9 * GB },
    { name: 'no-size-model' }, // no size → skipped
  ];

  it('assesses installed models by their on-disk size and infers a tier', async () => {
    const result = await assessInstalledModels(installed, {
      hardware: hw({ totalRamBytes: 64 * GB, vramBytes: 24 * GB, unifiedMemory: false }),
    });

    // The no-size model is skipped (its fit can't be judged).
    expect(result.map((m) => m.id)).toEqual(['qwen2.5-coder:7b', 'deepseek-coder-v2:16b']);
    expect(result[0].sizeBytes).toBe(4.7 * GB);
    expect(['runs-well', 'may-be-slow', 'too-large']).toContain(result[0].assessment.verdict);
    expect(result[0].assessment.explanation).toMatch(/estimate/i);
    // Tier inferred from the tag id (7b → quick-helper, 16b → solid-coder).
    expect(result[0].assessment.model.tier).toBe('quick-helper');
    expect(result[1].assessment.model.tier).toBe('solid-coder');
  });

  it('caps an installed frontier-family model below frontier (local is never frontier)', async () => {
    // A local deepseek-r1:14b matches the frontier pattern but must be demoted.
    const [entry] = await assessInstalledModels([{ name: 'deepseek-r1:14b', size: 9 * GB }], {
      hardware: hw({ totalRamBytes: 64 * GB, vramBytes: 24 * GB, unifiedMemory: false }),
    });
    expect(entry.assessment.model.tier).toBe('solid-coder');
  });

  it('calls a too-large verdict when the model dwarfs available memory', async () => {
    const [entry] = await assessInstalledModels([{ name: 'huge:70b', size: 40 * GB }], {
      hardware: hw({ totalRamBytes: 8 * GB, unifiedMemory: false }),
    });
    expect(entry.assessment.verdict).toBe('too-large');
  });
});
