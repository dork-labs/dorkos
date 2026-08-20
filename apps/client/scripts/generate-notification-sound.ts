// Generate the cockpit's three notification cues as WAV files.
// Run with: npx tsx apps/client/scripts/generate-notification-sound.ts
//
// Generated rather than sourced so the family stays coherent: three sounds
// written by one hand, in one gain range, with no licence to chase. Each one is
// a couple of sine tones under an envelope — the whole point is that none of
// them is a ringtone.
//
// The three, and what each one MEANS (the sounds exist to be distinguishable
// with your back to the screen, so the shapes are deliberately unalike):
//
//   knock.wav        a soft double-knock  — an agent stopped and needs you
//   settle.wav       a gentle falling third — the last thing waiting is answered
//   notification.wav the original two-tone chime — a turn finished (default off)

import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const SAMPLE_RATE = 44100;

/** One sine tone placed in time, with its own envelope. */
interface Tone {
  /** Hz. */
  frequency: number;
  /** Seconds from the start of the file. */
  startsAt: number;
  /** Peak amplitude, 0-1, before the envelope. */
  gain: number;
  /** Exponential decay rate — higher falls faster. */
  decay: number;
  /**
   * Seconds of fade-IN.
   *
   * Zero is a click at any real volume, so every tone here has some. A knock
   * wants almost none (that is what makes it percussive); a resolve wants
   * enough to arrive rather than start.
   */
  attack: number;
}

/** A cue: the file it writes, how long it runs, and the tones in it. */
interface Cue {
  file: string;
  duration: number;
  tones: Tone[];
}

/**
 * A soft double-knock.
 *
 * Low and wooden rather than bright — two short taps a tenth of a second apart,
 * each a low fundamental with a quieter octave above it for body. It is the one
 * cue that means "something is blocked on you", so it is the one that had to
 * sound like a person at a door rather than a device.
 */
const KNOCK: Cue = {
  file: 'knock.wav',
  duration: 0.32,
  tones: [
    { frequency: 196, startsAt: 0, gain: 0.32, decay: 34, attack: 0.002 },
    { frequency: 392, startsAt: 0, gain: 0.1, decay: 44, attack: 0.002 },
    { frequency: 185, startsAt: 0.11, gain: 0.28, decay: 34, attack: 0.002 },
    { frequency: 370, startsAt: 0.11, gain: 0.09, decay: 44, attack: 0.002 },
  ],
};

/**
 * A gentle resolve — the sound of a queue emptying.
 *
 * A falling major third (E5 to C5) with a slow attack and a long tail, so it
 * reads as an ending rather than an event. Quieter than the knock on purpose:
 * nothing needs doing when this plays.
 */
const SETTLE: Cue = {
  file: 'settle.wav',
  duration: 0.7,
  tones: [
    { frequency: 659.25, startsAt: 0, gain: 0.16, decay: 7, attack: 0.02 },
    { frequency: 523.25, startsAt: 0.13, gain: 0.16, decay: 5, attack: 0.03 },
    // The fifth under both, very quiet — it is what keeps the fall from sounding
    // like an error tone.
    { frequency: 349.23, startsAt: 0.13, gain: 0.07, decay: 4, attack: 0.05 },
  ],
};

/**
 * The original turn-finished chime, unchanged.
 *
 * Byte-for-byte the sound this script has always produced (A5 + C6, 250ms,
 * `exp(-t * 12)`), because it is the one people already know — it only changed
 * meaning: it is now off by default and says "a turn finished", not "something
 * needs you".
 */
const TURN_END: Cue = {
  file: 'notification.wav',
  duration: 0.25,
  tones: [
    { frequency: 880, startsAt: 0, gain: 0.3, decay: 12, attack: 0 },
    { frequency: 1047, startsAt: 0, gain: 0.2, decay: 12, attack: 0 },
  ],
};

const CUES: Cue[] = [KNOCK, SETTLE, TURN_END];

/** Render one cue to mono float samples in [-1, 1]. */
function renderCue(cue: Cue): Float32Array {
  const sampleCount = Math.floor(SAMPLE_RATE * cue.duration);
  const samples = new Float32Array(sampleCount);

  for (const tone of cue.tones) {
    const firstSample = Math.floor(tone.startsAt * SAMPLE_RATE);
    for (let i = firstSample; i < sampleCount; i++) {
      const t = (i - firstSample) / SAMPLE_RATE;
      const decay = Math.exp(-t * tone.decay);
      // A linear ramp in, so the tone starts at silence instead of at full
      // amplitude. `attack: 0` skips it and reproduces the original chime.
      const attack = tone.attack === 0 ? 1 : Math.min(1, t / tone.attack);
      samples[i]! += Math.sin(2 * Math.PI * tone.frequency * t) * tone.gain * decay * attack;
    }
  }

  return samples;
}

/** Wrap mono 16-bit PCM samples in a WAV container. */
function createWav(samples: Float32Array): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write samples
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    const intSample = Math.floor(sample * 32767);
    buffer.writeInt16LE(intSample, headerSize + i * 2);
  }

  return buffer;
}

const currentDir = dirname(fileURLToPath(import.meta.url));

for (const cue of CUES) {
  const wav = createWav(renderCue(cue));
  const outputPath = resolve(currentDir, '../public', cue.file);
  writeFileSync(outputPath, wav);
  console.log(`Generated ${cue.file}: ${outputPath} (${wav.length} bytes)`);
}
