---
name: vectorizing-images
description: Converts raster images (PNG/JPG) to SVG vectors using @neplex/vectorizer. Use when creating scalable logos, preparing images for print, or converting AI-generated images to vectors.
---

# Vectorizing Images

This skill guides **raster-to-vector conversion** using @neplex/vectorizer (Node.js). It covers tool selection, usage patterns, and production workflows for converting PNG/JPG images to scalable SVG vectors.

## Quick Reference

| Task | Command |
|------|---------|
| Install | `npm install @neplex/vectorizer` |
| Vectorize | `vectorize(buffer, Preset.Photo)` |
| Optimize SVG | `npx svgo input.svg -o output.svg` |

## When to Use

- Converting AI-generated logos to scalable vectors
- Preparing raster images for print (logos, icons)
- Creating SVG versions of PNG/JPG assets
- Logo production pipeline (generate → vectorize → optimize)

## Tool Recommendation

**Primary tool**: `@neplex/vectorizer` (Node.js)

| Factor | @neplex/vectorizer | vtracer (Python) |
|--------|-------------------|------------------|
| Engine | VTracer (Rust) | VTracer (Rust) |
| Quality | Identical | Identical |
| Project fit | Native (Node.js) | Requires subprocess |
| File sizes | Slightly smaller | Slightly larger |

Both use the same underlying VTracer Rust engine. Choose based on your project's language:
- **Node.js/TypeScript projects** → @neplex/vectorizer (this skill)
- **Python projects** → vtracer

## Installation

```bash
npm install @neplex/vectorizer
```

## Basic Usage

```typescript
import { vectorize, Preset } from '@neplex/vectorizer';
import fs from 'fs/promises';

const buffer = await fs.readFile('logo.png');
const svg = await vectorize(buffer, Preset.Photo);
await fs.writeFile('logo.svg', svg);
```

## Presets

| Preset | Best For |
|--------|----------|
| `Preset.Photo` | **Logos, detailed images** (recommended default) |
| `Preset.Illustration` | Simple illustrations, icons |
| `Preset.Silhouette` | Monochrome shapes |

**Always use `Preset.Photo` for logos** — it produces the best results for typical use cases.

## Critical Gotchas

### 1. Use Presets, Not Custom Config

Custom configuration objects have TypeScript enum issues. Use presets instead:

```typescript
// WRONG - TypeScript errors with custom config
const svg = await vectorize(buffer, {
  colorMode: ColorMode.Color,  // Enum errors
  // ...
});

// CORRECT - Use presets
const svg = await vectorize(buffer, Preset.Photo);
```

### 2. Transparent Backgrounds

VTracer traces what it sees in the image:
- **Source has solid background** → Background becomes an SVG path
- **Source has alpha transparency** → Background is transparent in SVG

To get transparent backgrounds, remove the background from the source image first (use rembg via `generating-images-replicate` skill).

### 3. Gradients Become Stacked Layers

VTracer does NOT create SVG `<linearGradient>` elements. Instead:
- Gradients are approximated as stacked `<path>` elements
- Each path has a different solid fill color
- This is acceptable for most logos and works well visually

### 4. potrace is Monochrome Only

Do NOT use potrace for color images — it converts everything to black silhouettes. Only use potrace if you specifically want monochrome output.

### 5. img2vector is Broken

The Python `img2vector` package has broken imports. Avoid until maintainers fix it. Use `vtracer` directly instead.

## File Size Expectations

From testing with logo images:

| Complexity | Expected Size |
|------------|---------------|
| Simple (monochrome line art) | 15-20 KB |
| Medium (solid colors) | 25-35 KB |
| Complex (gradients, detail) | 30-40 KB |

These sizes are production-ready and acceptable for web use.

## Post-Processing (Optional)

For production SVGs, optimize with SVGO to reduce file size by 10-30%:

```bash
npx svgo logo.svg -o logo.optimized.svg
```

Or programmatically:

```typescript
import { optimize } from 'svgo';

const optimized = optimize(svgString, {
  multipass: true,
});
```

## Workflow Integration

```
1. Generate image (Replicate) or obtain source PNG
2. Download to .temp/images/
3. Vectorize with @neplex/vectorizer
4. Review SVG output
5. Optimize with SVGO (optional)
6. Move to public/images/ or src/assets/
```

### Example Workflow Script

```typescript
import { vectorize, Preset } from '@neplex/vectorizer';
import { optimize } from 'svgo';
import fs from 'fs/promises';

async function vectorizeLogo(inputPath: string, outputPath: string) {
  // 1. Read source image
  const buffer = await fs.readFile(inputPath);

  // 2. Vectorize
  const svg = await vectorize(buffer, Preset.Photo);

  // 3. Optimize (optional)
  const optimized = optimize(svg, { multipass: true });

  // 4. Write output
  await fs.writeFile(outputPath, optimized.data);

  console.log(`Vectorized: ${inputPath} → ${outputPath}`);
}

// Usage
await vectorizeLogo('.temp/images/logo.png', 'public/images/logo.svg');
```

## Decision Matrix

| Scenario | Tool |
|----------|------|
| Node.js project, color images | @neplex/vectorizer (this skill) |
| Python project, color images | vtracer (same engine) |
| Monochrome images only | potrace (smaller files) |
| Need background removed first | Use rembg first, then vectorize |

## What This Skill Does NOT Cover

- **Background removal** — Use `generating-images-replicate` skill with rembg
- **SVG editing/manipulation** — Use vector editing tools (Figma, Illustrator)
- **SVG animation** — Use CSS animations or Motion library
- **True SVG gradients** — Must be added manually in a vector editor

## References

- [@neplex/vectorizer](https://www.npmjs.com/package/@neplex/vectorizer) — NPM package
- [VTracer](https://github.com/nicoptere/vtracer) — Underlying Rust engine
- [SVGO](https://github.com/svg/svgo) — SVG optimization
- [Comparison Report](docs/logo-design/03-vectorization-comparison.md) — Detailed testing results
