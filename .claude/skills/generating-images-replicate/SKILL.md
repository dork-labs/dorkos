---
name: generating-images-replicate
description: Image generation and processing using the Replicate MCP server. Use for creating images, background removal, upscaling, editing photos, or adding images to web pages. Handles model selection, temp storage, user preview, and processing.
license: Complete terms in LICENSE.txt
---

# Image Generation with Replicate

This skill guides **image generation and processing workflows** using the Replicate MCP server. It covers generation, background removal, upscaling, file management, and integration into web applications.

## Quick Reference

| Task | Tool/Command |
|------|--------------|
| Generate image | `mcp__replicate__create_models_predictions` (nano-banana) |
| Generate logo (vector) | `mcp__replicate__create_models_predictions` (recraft-v3-svg) |
| Generate logo (raster) | `mcp__replicate__create_models_predictions` (ideogram-v3-turbo) |
| Remove background | `mcp__replicate__create_models_predictions` (cjwbw/rembg) |
| Upscale image | `mcp__replicate__create_models_predictions` (nightmareai/real-esrgan) |
| Search models | `mcp__replicate__search` |
| Get model info | `mcp__replicate__get_models` |
| Download image | `curl -sL "<url>" -o "<path>"` |
| Display to user | `open -a "Google Chrome" <file>` |
| Resize image | `sips -Z <max-dimension> <file>` |
| Convert format | `sips -s format jpeg -s formatOptions 80 <file> --out <output>` |

## Workflow Overview

```
1. Generate → 2. Download to .temp/ → 3. Display → 4. Process (optional) → 5. Move to final location
```

## Model Selection

Choose the right model for the task:

| Model | Use Case | Speed | Quality | Cost |
|-------|----------|-------|---------|------|
| `google/nano-banana` | General image gen/editing, versatile | Fast (~6s) | High | $$ |
| `google/nano-banana-pro` | Higher quality, up to 2K resolution | Medium (~28s) | Very High | $$$ |
| `black-forest-labs/flux-schnell` | Fast prototyping, local dev | Fastest (~2s) | Good | $ |
| `black-forest-labs/flux-1.1-pro` | Excellent prompt adherence | Fast (~3.5s) | High | $$ |
| `black-forest-labs/flux-2-pro` | Latest Flux, improved detail | Medium (~10s) | Excellent | $$$ |
| `black-forest-labs/flux-kontext-pro` | Image editing with text prompts | Medium | High | $$ |
| `recraft-ai/recraft-v3-svg` | **Logos** — native SVG vector output | Medium (~11s) | Excellent | $$ |
| `recraft-ai/recraft-v3` | Illustrations, 2D art styles | Fast (~7s) | High | $$ |
| `ideogram-ai/ideogram-v3-turbo` | Text rendering, wordmarks | Fast (~5s) | High | $$ |
| `google/imagen-4` | Google's flagship text-to-image | Slow | Excellent | $$$ |
| `google/imagen-4-ultra` | Highest quality (when it matters) | Slowest | Best | $$$$ |
| `bytedance/seedream-4` | Text-to-image + editing, up to 4K | Medium | Excellent | $$$ |

### Default Choice: `google/nano-banana`

For most use cases, **Nano Banana** is the recommended default because:
- Versatile: Both generation and editing
- Fast: ~6 second generation time
- High quality output
- Supports multiple input images
- Flexible aspect ratios

### When to Choose Alternatives

| Scenario | Recommended Model |
|----------|-------------------|
| Need 2K+ resolution | `nano-banana-pro` |
| Quick prototypes/iterations | `flux-schnell` |
| Editing existing images with text | `flux-kontext-pro` |
| Highest possible quality | `imagen-4-ultra` |
| Text rendering in images | `imagen-4` or `seedream-4` |
| **Logo generation (vector)** | `recraft-v3-svg` |
| **Logo generation (raster)** | `ideogram-v3-turbo` |
| **Wordmarks with text** | `ideogram-v3-turbo` |

## Logo Generation

Generate professional logos with wordmarks and icons. **Key insight**: For production logos, use `recraft-ai/recraft-v3-svg` — it's the only model that outputs native SVG vectors, essential for logos that need to scale from favicons to billboards.

### Logo Model Recommendations

| Model | Best For | Output | Speed | Notes |
|-------|----------|--------|-------|-------|
| `recraft-ai/recraft-v3-svg` | Production logos | SVG (vector) | ~11s | **Only model with native vector output** |
| `ideogram-ai/ideogram-v3-turbo` | Wordmarks, text-heavy logos | PNG | ~5s | Superior text rendering |
| `black-forest-labs/flux-2-pro` | High detail conceptual logos | PNG | ~10s | Latest Flux, excellent prompt adherence |
| `google/nano-banana-pro` | Detailed logo concepts | PNG | ~28s | Highest detail, slower |
| `recraft-ai/recraft-v3` | Quick logo iterations | WebP | ~7s | Use `style: "digital_illustration/2d_art_poster"` |
| `google/nano-banana` | Fast logo prototyping | PNG | ~6s | Good for initial concepts |

### Logo Prompt Pattern

Use this template for consistent results:

```
A professional modern logo for [company type] called '[Name]'.
The logo features a minimalist [icon description] combined with
the wordmark '[NAME]' in a clean sans-serif font.
Clean white background, vector style, suitable for business use.
```

**Example:**
```
A professional modern logo for a tech startup called 'Lumina'.
The logo features a minimalist lightbulb icon combined with
the wordmark 'LUMINA' in a clean sans-serif font.
Clean white background, vector style, suitable for business use.
```

### Logo Generation Workflow

```typescript
// For production logos (SVG vector output)
mcp__replicate__create_models_predictions({
  model_owner: "recraft-ai",
  model_name: "recraft-v3-svg",
  input: {
    prompt: "A professional modern logo for a tech startup called 'Lumina'. The logo features a minimalist lightbulb icon combined with the wordmark 'LUMINA' in a clean sans-serif font. Clean white background, vector style, suitable for business use."
  },
  Prefer: "wait",
  jq_filter: "{id, status, output, error}"
})

// For text-heavy logos/wordmarks
mcp__replicate__create_models_predictions({
  model_owner: "ideogram-ai",
  model_name: "ideogram-v3-turbo",
  input: {
    prompt: "...",
    aspect_ratio: "1:1"
  },
  Prefer: "wait",
  jq_filter: "{id, status, output, error}"
})
```

### Important Gotchas

| Issue | Solution |
|-------|----------|
| `recraft-v3` style "logo" doesn't exist | Use `style: "digital_illustration/2d_art_poster"` instead |
| `laion-ai/erlich` (logo model) returns 404 | Model is deprecated — use alternatives above |
| Wordmark text is garbled | Use `ideogram-v3-turbo` — best text rendering |
| Need scalable output | Use `recraft-v3-svg` — only model with SVG output |

### File Organization for Logos

Store logo iterations in a dedicated subfolder:

```
.temp/
└── images/
    └── logos/           # Logo iterations
        ├── concept-v1.png
        ├── concept-v2.png
        └── final.svg    # SVG from recraft-v3-svg
```

### Multi-Model Comparison

When comparing models for logo quality, generate with the same prompt across models:

```bash
# Create comparison directory
mkdir -p .temp/images/logo-comparison/{recraft-v3-svg,ideogram-v3-turbo,flux-2-pro,nano-banana-pro}
```

Then generate with each model, download to respective folders, and review side-by-side.

## Generation Workflow

### Step 1: Generate Image

```typescript
// Basic generation
mcp__replicate__create_models_predictions({
  model_owner: "google",
  model_name: "nano-banana",
  input: {
    prompt: "A cozy coffee shop interior, warm lighting, minimal style",
    aspect_ratio: "16:9",  // or "1:1", "9:16", "4:3", "3:4"
    output_format: "png"   // or "jpg"
  },
  Prefer: "wait",  // Wait for completion (up to 60s)
  jq_filter: "{id, status, output, error}"
})
```

### Step 2: Download to Temp Directory

Always download to `.temp/images/` first:

```bash
# Create temp directory if needed
mkdir -p .temp/images

# Download image
curl -sL "<replicate-url>" -o ".temp/images/<descriptive-name>.png"
```

**Naming convention**: Use descriptive names like:
- `hero-banner-v1.png`
- `product-photo-dark.jpg`
- `avatar-watercolor.png`

### Step 3: Display to User

Open the image in Chrome for user review:

```bash
open -a "Google Chrome" .temp/images/generated-image.png
```

This opens the image in a browser tab where the user can inspect it at full resolution.

### Step 4: Process (Optional)

Common processing operations using macOS `sips`:

```bash
# Resize to max dimension (maintains aspect ratio)
sips -Z 800 .temp/images/image.png

# Resize to exact dimensions
sips -z 600 800 .temp/images/image.png

# Convert PNG to JPEG with quality
sips -s format jpeg -s formatOptions 80 input.png --out output.jpg

# Get image dimensions
sips -g pixelWidth -g pixelHeight image.png

# Rotate image
sips -r 90 image.png  # 90 degrees clockwise
```

### Step 5: Move to Final Location

```bash
# For public assets (accessible via URL)
cp .temp/images/final-image.jpg public/images/

# For app-specific assets
cp .temp/images/final-image.jpg src/assets/images/
```

## Multi-Image Generation

When generating variations for user selection, generate in parallel:

```typescript
// Generate 3 variations in parallel
mcp__replicate__create_models_predictions({
  model_owner: "google",
  model_name: "nano-banana",
  input: { prompt: "Coffee shop, minimal style", aspect_ratio: "16:9" },
  Prefer: "wait",
  jq_filter: "{id, status, output}"
})
mcp__replicate__create_models_predictions({
  model_owner: "google",
  model_name: "nano-banana",
  input: { prompt: "Coffee shop, watercolor style", aspect_ratio: "16:9" },
  Prefer: "wait",
  jq_filter: "{id, status, output}"
})
mcp__replicate__create_models_predictions({
  model_owner: "google",
  model_name: "nano-banana",
  input: { prompt: "Coffee shop, photorealistic", aspect_ratio: "16:9" },
  Prefer: "wait",
  jq_filter: "{id, status, output}"
})
```

Then download all and display for comparison.

## Image Editing

Nano Banana supports image editing with reference images:

```typescript
mcp__replicate__create_models_predictions({
  model_owner: "google",
  model_name: "nano-banana",
  input: {
    prompt: "Change the background to a sunset beach",
    image_input: ["https://example.com/original-image.jpg"],
    aspect_ratio: "match_input_image"
  },
  Prefer: "wait",
  jq_filter: "{id, status, output}"
})
```

## Background Removal

Remove backgrounds from images to create transparent PNGs for product photos, profile pictures, or compositing.

### Models

| Model | Use Case | Speed | Notes |
|-------|----------|-------|-------|
| `cjwbw/rembg` | General purpose | Fast (~2s) | Simple, reliable, ~$0.004/run |
| `smoretalk/rembg-enhance` | Better edges | Medium | Enhanced matting, 5.4M+ runs |
| `men1scus/birefnet` | High-res, fine detail | Medium | Best for hair/fur, 4.1M+ runs |
| `lucataco/rembg-video` | Video frames | Varies | For video background removal |

### Default: `cjwbw/rembg`

For most use cases, start with rembg — it's fast, cheap, and handles common scenarios well.

### Workflow

```typescript
// Remove background
mcp__replicate__create_models_predictions({
  model_owner: "cjwbw",
  model_name: "rembg",
  input: {
    image: "https://example.com/photo.jpg"  // URL to source image
  },
  Prefer: "wait",
  jq_filter: "{id, status, output, error}"
})
```

Then download and display:

```bash
curl -sL "<output-url>" -o ".temp/images/cutout.png"
open -a "Google Chrome" .temp/images/cutout.png
```

### When to Use Enhanced Models

| Scenario | Model |
|----------|-------|
| Fine hair or fur edges | `men1scus/birefnet` |
| Product photography | `smoretalk/rembg-enhance` |
| Simple/clear subjects | `cjwbw/rembg` (default) |
| Video frames | `lucataco/rembg-video` |

## Image Upscaling

Increase image resolution while preserving or enhancing detail. Useful for low-res sources, enlarging generated images, or preparing images for print.

### Models

| Model | Use Case | Speed | Scale | Notes |
|-------|----------|-------|-------|-------|
| `nightmareai/real-esrgan` | General upscaling | Fast (~1.8s on T4) | 2-10x | Best all-rounder, includes face fix |
| `lucataco/real-esrgan` | Larger images | Medium | 2-10x | More GPU RAM |
| `daanelson/real-esrgan-a100` | Speed priority | Fastest (~0.7s) | 2-10x | A100 GPU, costs more |

### Default: `nightmareai/real-esrgan`

Fast, reliable, and includes optional GFPGAN face enhancement.

### Workflow

```typescript
// Upscale image 4x
mcp__replicate__create_models_predictions({
  model_owner: "nightmareai",
  model_name: "real-esrgan",
  input: {
    image: "https://example.com/low-res.jpg",
    scale: 4,           // 2-10x (default: 4)
    face_enhance: true  // Optional: fix faces with GFPGAN
  },
  Prefer: "wait",
  jq_filter: "{id, status, output, error}"
})
```

### Guidelines

| Input Size | Recommended Scale | Output Size |
|------------|-------------------|-------------|
| 256px | 4x | 1024px |
| 512px | 4x | 2048px |
| 1024px | 2x | 2048px |
| 1440px+ | 2x max | Keep under source limits |

**Note**: Keep input images ≤1440p for best results. Larger inputs may fail or produce artifacts.

### When to Upscale

- Low-resolution source images
- Generated images that need higher resolution
- Preparing images for print (300 DPI requirement)
- Enlarging thumbnails or icons

## Aspect Ratios

| Ratio | Use Case |
|-------|----------|
| `1:1` | Profile pictures, thumbnails, social media squares |
| `16:9` | Hero banners, video thumbnails, desktop headers |
| `9:16` | Mobile stories, vertical video, phone wallpapers |
| `4:3` | Product photos, blog images |
| `3:4` | Portrait photos, Pinterest pins |
| `match_input_image` | When editing, match the source image |

## MCP Server Tips

### Handling Timeouts

The Replicate MCP server can timeout on large requests. Mitigations:

1. **Use small limits**: `limit: 3` instead of `limit: 10` on searches
2. **Use jq_filter**: Always filter response to essential fields
3. **Direct model lookup**: Use `get_models` instead of `search` when you know the model name

### Essential jq_filters

```typescript
// For predictions
jq_filter: "{id, status, output, error, metrics}"

// For model info
jq_filter: "{name, owner, description, run_count}"

// For searches
jq_filter: ".models[] | {name: .model.name, owner: .model.owner, description: .model.description}"
```

### SSE Connection Issues

The Replicate MCP uses Server-Sent Events (SSE). If experiencing persistent timeouts:

1. **Retry the request** — SSE connections can be intermittent
2. **Simplify the request** — Remove optional parameters
3. **Check Replicate status** — Visit https://status.replicate.com
4. **Fall back to REST API** — Use curl with REPLICATE_API_TOKEN if MCP is unavailable

## Error Handling

### Common Errors and Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| Timeout | MCP SSE connection lost | Retry request, use jq_filter |
| `status: "failed"` | Model error | Check `error` field, adjust inputs |
| Empty output | Processing not complete | Use `Prefer: "wait"` or poll status |
| 413 Payload Too Large | Input image too big | Resize input before sending |

### Retry Pattern

When a prediction fails, implement retry logic:

```typescript
// Attempt 1
const result = await mcp__replicate__create_models_predictions({...})

// If failed or timeout, try again with simpler request
if (!result || result.status === "failed") {
  // Retry with minimal jq_filter
  const retry = await mcp__replicate__create_models_predictions({
    ...sameInput,
    jq_filter: "{id, status, output}"
  })
}
```

### Graceful Degradation

When MCP is unavailable, inform the user:
1. Acknowledge the issue
2. Suggest trying again later
3. Offer alternative approaches (local tools, different workflow)

## Cost & Speed Reference

### Generation Models

| Model | Speed | Cost per Run | Best For |
|-------|-------|--------------|----------|
| `flux-schnell` | ~2s | ~$0.003 | Prototyping, iterations |
| `nano-banana` | ~6s | ~$0.01 | Production quality |
| `nano-banana-pro` | ~15s | ~$0.03 | High resolution |
| `imagen-4` | ~30s | ~$0.05 | Premium quality |
| `imagen-4-ultra` | ~60s | ~$0.10+ | Best possible |

### Processing Models

| Model | Speed | Cost per Run | Best For |
|-------|-------|--------------|----------|
| `rembg` | ~2s | ~$0.004 | Background removal |
| `real-esrgan` (T4) | ~1.8s | ~$0.005 | Upscaling |
| `real-esrgan` (A100) | ~0.7s | ~$0.02 | Fast upscaling |

### Cost Optimization Tips

1. **Use `flux-schnell` for iterations** — Get composition right before using expensive models
2. **Downsize inputs when possible** — Smaller inputs = faster processing
3. **Batch similar requests** — Parallel calls are more efficient than sequential
4. **Cache results** — Don't regenerate the same image twice

### Token Usage

MCP tool calls use minimal tokens (~100-300 per call). The actual cost is in Replicate compute, not Claude tokens. For high-volume work, consider:
- Using a dedicated image-generation subagent
- Batching requests
- Caching generated images

## File Organization

```
.temp/
└── images/           # Temporary generated images (gitignored)
    ├── hero-v1.png
    ├── hero-v2.png
    └── hero-final.jpg

public/
└── images/           # Production images (served statically)
    └── hero.jpg

src/
└── assets/
    └── images/       # App-bundled images
        └── logo.svg
```

## Processing Reference

### sips Commands (macOS)

| Command | Description |
|---------|-------------|
| `sips -Z <size> <file>` | Resize to fit within size (aspect ratio preserved) |
| `sips -z <h> <w> <file>` | Resize to exact dimensions |
| `sips -s format jpeg <file> --out <out>` | Convert to JPEG |
| `sips -s formatOptions <0-100> <file>` | Set JPEG quality |
| `sips -r <degrees> <file>` | Rotate clockwise |
| `sips -c <h> <w> <file>` | Crop to dimensions |
| `sips -g pixelWidth -g pixelHeight <file>` | Get dimensions |

### Web Optimization Guidelines

| Use Case | Format | Quality | Max Size |
|----------|--------|---------|----------|
| Hero images | JPEG | 80-85 | 1920px wide |
| Thumbnails | JPEG | 75 | 400px |
| Icons/logos | PNG | N/A | 64-256px |
| Photos | JPEG | 80 | 1200px |
| Screenshots | PNG | N/A | As needed |

## Cleanup

After user selects final image(s), clean up temp files:

```bash
# Remove all temp images
rm -rf .temp/images/*

# Or remove specific files
rm .temp/images/rejected-*.png
```

## Checklist

Before finalizing generated images:

- [ ] Image displays correctly to user
- [ ] User has approved the selection
- [ ] Image is appropriately sized for use case
- [ ] Format is optimized (JPEG for photos, PNG for graphics)
- [ ] File is moved to correct permanent location
- [ ] Temp files are cleaned up
- [ ] Image path is correct in code/markup

## Integration Examples

### Next.js Image Component

```tsx
import Image from 'next/image'

// For images in public/
<Image
  src="/images/hero.jpg"
  alt="Hero banner"
  width={1920}
  height={1080}
  priority
/>

// For external URLs (add to next.config.ts remotePatterns)
<Image
  src="https://replicate.delivery/..."
  alt="Generated image"
  width={800}
  height={600}
/>
```

### Background Image (CSS)

```tsx
<div
  className="bg-cover bg-center h-96"
  style={{ backgroundImage: "url('/images/hero.jpg')" }}
/>
```

## References

### Documentation
- Replicate API: https://replicate.com/docs
- Replicate Status: https://status.replicate.com
- sips documentation: `man sips`

### Generation Models
- Nano Banana: https://replicate.com/google/nano-banana
- Nano Banana Pro: https://replicate.com/google/nano-banana-pro
- Flux Schnell: https://replicate.com/black-forest-labs/flux-schnell
- Flux 1.1 Pro: https://replicate.com/black-forest-labs/flux-1.1-pro
- Flux 2 Pro: https://replicate.com/black-forest-labs/flux-2-pro
- Imagen 4: https://replicate.com/google/imagen-4

### Logo Models
- Recraft V3 SVG (vector logos): https://replicate.com/recraft-ai/recraft-v3-svg
- Recraft V3 (raster): https://replicate.com/recraft-ai/recraft-v3
- Ideogram V3 Turbo (text/wordmarks): https://replicate.com/ideogram-ai/ideogram-v3-turbo

### Processing Models
- Background Removal (rembg): https://replicate.com/cjwbw/rembg
- Background Removal (enhanced): https://replicate.com/smoretalk/rembg-enhance
- Upscaling (Real-ESRGAN): https://replicate.com/nightmareai/real-esrgan

### Collections
- Background Removal: https://replicate.com/collections/remove-backgrounds
- Super Resolution: https://replicate.com/collections/super-resolution
