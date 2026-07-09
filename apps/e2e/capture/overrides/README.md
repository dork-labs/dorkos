# Human overrides

Committed, hand-captured media that **beats the automated capture** for a shot.
When the harness can't reach a surface (a real device recording, a hardware
demo, a hand-polished hero) or a shot simply reads better shot by a person, drop
the file here and it wins.

## Workflow

1. Make a directory named exactly for the shot id (see `../shots.ts`):

   ```
   overrides/<shot-id>/
   ```

2. Drop one or both source files in it:

   | File                           | Replaces                                |
   | ------------------------------ | --------------------------------------- |
   | `still-light.png`              | the shot's light still                  |
   | `loop-dark.{mp4,mov,webm,mkv}` | the shot's dark loop **and** its poster |

   A loop override may only target a shot the registry marks as `kind: 'loop'`.

3. Optionally add `override.json`:

   ```json
   {
     "reason": "Filmed on a real iPhone — the emulator can't show haptics",
     "capturedBy": "dorian",
     "date": "2026-07-09",
     "skipAuto": true
   }
   ```

   `skipAuto: true` tells the **record** phase not to capture this shot from the
   app at all — your override is its sole source. (A shot can also be flagged
   `skipAuto` directly in `shots.ts`.)

4. Re-process:

   ```bash
   pnpm --filter @dorkos/e2e capture:process
   ```

   The override runs through the **same** optimization path as an automated
   capture — palette-quantized PNG for stills; fps-normalized, two-pass VP9 with
   an extracted poster for loops — and is scaled to the shot's target
   dimensions. It is re-applied on top of the auto-processed set every process
   run, so wiping the output dir first stays safe, and the manifest tags it
   `source: "manual"` with your provenance.

## Aspect ratio

The pipeline **scales but never crops**. If a source's aspect ratio doesn't
match the shot's frame (16:10 desktop, 390:844 mobile), that shot fails with an
actionable error naming the expected ratio. Recapture at the right aspect — the
pipeline will not silently distort or crop your media.

## What's committed

Override **source** files under this directory are committed (they are the
human-authored input, not regenerable). The processed output still lands in
`apps/site/public/product/` like any other asset.
