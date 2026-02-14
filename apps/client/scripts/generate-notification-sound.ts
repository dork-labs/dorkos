// Generate a simple notification sound WAV file
// Run with: npx tsx apps/client/scripts/generate-notification-sound.ts

import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const SAMPLE_RATE = 44100;
const DURATION = 0.25; // 250ms
const NUM_SAMPLES = Math.floor(SAMPLE_RATE * DURATION);

function generateSamples(): Float32Array {
  const samples = new Float32Array(NUM_SAMPLES);

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const t = i / SAMPLE_RATE;

    // Two-tone chime: A5 (880Hz) + C6 (1047Hz)
    const tone1 = Math.sin(2 * Math.PI * 880 * t) * 0.3;
    const tone2 = Math.sin(2 * Math.PI * 1047 * t) * 0.2;

    // Fast attack, exponential decay
    const envelope = Math.exp(-t * 12);

    samples[i] = (tone1 + tone2) * envelope;
  }

  return samples;
}

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
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const intSample = Math.floor(sample * 32767);
    buffer.writeInt16LE(intSample, headerSize + i * 2);
  }

  return buffer;
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const samples = generateSamples();
const wav = createWav(samples);

const outputPath = resolve(currentDir, '../public/notification.wav');
writeFileSync(outputPath, wav);
console.log(`Generated notification sound: ${outputPath} (${wav.length} bytes)`);
