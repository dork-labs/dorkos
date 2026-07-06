import { describe, it, expect } from 'vitest';
import type { OllamaHardware } from '@dorkos/shared/runtime-connect';
import {
  OLLAMA_CODING_MODELS,
  DEFAULT_OLLAMA_MODEL_ID,
  resolveCuratedModel,
  detectHardware,
  classifyModelFit,
  assessOllamaModels,
} from '../ollama-catalog.js';

const GB = 1024 ** 3;

/** Build a hardware snapshot for a table-test row. */
function hw(overrides: Partial<OllamaHardware>): OllamaHardware {
  return { totalRamBytes: 16 * GB, vramBytes: null, unifiedMemory: false, ...overrides };
}

const MODEL_7B = OLLAMA_CODING_MODELS.find((m) => m.id === 'qwen2.5-coder:7b')!;
const MODEL_14B = OLLAMA_CODING_MODELS.find((m) => m.id === 'qwen2.5-coder:14b')!;

describe('curated Ollama coding catalog', () => {
  it('is tiny, honest, and never oversells a small local model', () => {
    // Deliberately small — a couple of curated options, not an open browser.
    expect(OLLAMA_CODING_MODELS.length).toBeGreaterThanOrEqual(1);
    expect(OLLAMA_CODING_MODELS.length).toBeLessThanOrEqual(3);
    for (const model of OLLAMA_CODING_MODELS) {
      expect(model.sizeLabel).toMatch(/GB/);
      expect(model.downloadBytes).toBeGreaterThan(0);
      expect(model.minMemoryBytes).toBeGreaterThan(0);
      // Honest capability caveat: never implies frontier/Claude equivalence.
      expect(model.note.toLowerCase()).toMatch(/not|limited|short of|frontier/);
    }
  });

  it('resolves curated ids and rejects uncurated ones', () => {
    expect(resolveCuratedModel('qwen2.5-coder:7b')?.id).toBe('qwen2.5-coder:7b');
    expect(resolveCuratedModel(DEFAULT_OLLAMA_MODEL_ID)).not.toBeNull();
    // An arbitrary id is not guided here — power users pull it via Ollama directly.
    expect(resolveCuratedModel('some/evil-model:latest')).toBeNull();
    expect(resolveCuratedModel('')).toBeNull();
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
  it('assesses every curated model against the injected hardware', () => {
    const catalog = assessOllamaModels({
      hardware: hw({ totalRamBytes: 4 * GB, unifiedMemory: false }),
    });
    expect(catalog.hardware.totalRamBytes).toBe(4 * GB);
    expect(catalog.models).toHaveLength(OLLAMA_CODING_MODELS.length);
    // 4 GB is below both models' footprints → all too-large.
    expect(catalog.models.every((m) => m.verdict === 'too-large')).toBe(true);
  });

  it('falls back to real hardware detection when none is injected', () => {
    const catalog = assessOllamaModels();
    expect(catalog.hardware.totalRamBytes).toBeGreaterThan(0);
    expect(catalog.models).toHaveLength(OLLAMA_CODING_MODELS.length);
  });
});
