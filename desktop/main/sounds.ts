// Built-in sounds, generated in code so the repository ships no audio files (spec §19.3 asks for our own files).
// "ok" is a soft rising pair (turn finished); "ack" is a single short blip (waiting for you).

const RATE = 22_050;

function tone(freq: number, ms: number, gain = 0.35): Int16Array {
  const n = Math.floor((RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    // 8 ms attack and a smooth decay so there are no clicks
    const env = Math.min(1, i / (RATE * 0.008)) * Math.pow(1 - i / n, 1.5);
    out[i] = Math.round(Math.sin(2 * Math.PI * freq * t) * env * gain * 32767);
  }
  return out;
}

export function wavFromSamples(samples: Int16Array, rate = RATE): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function synthWav(id: "ok" | "ack"): Buffer {
  if (id === "ack") return wavFromSamples(tone(880, 140));
  const a = tone(660, 110), b = tone(990, 180);
  const gap = new Int16Array(Math.floor(RATE * 0.02));
  const all = new Int16Array(a.length + gap.length + b.length);
  all.set(a, 0); all.set(gap, a.length); all.set(b, a.length + gap.length);
  return wavFromSamples(all);
}
