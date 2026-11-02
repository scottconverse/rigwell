// Audio helpers for dictation. Pure functions so they can be unit tested without a microphone.

/** Linear resampling of mono samples from one rate to another. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const n = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = pos - i0;
    out[i] = input[Math.min(i0, input.length - 1)] * (1 - f) + input[i1] * f;
  }
  return out;
}

/** Averages channels into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0]?.length ?? 0);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
}

/** 16-bit PCM mono WAV file. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Decoded recording (any channel count and rate) to the WAV the speech-to-text program expects: 16 kHz mono. */
export function toSpeechWav(channels: Float32Array[], rate: number): Uint8Array {
  return encodeWav(resample(downmix(channels), rate, 16000), 16000);
}
