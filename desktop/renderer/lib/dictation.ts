// Microphone capture for dictation. The recording stays in this window until the main process hands it to the speech-to-text
// backend the user configured (offline by default). Needs a real or fake audio device, so it is covered by the Electron test.
import { toSpeechWav } from "./wav.ts";

export interface Recording {
  /** Stops recording and returns 16 kHz mono WAV bytes. */
  stop(): Promise<Uint8Array>;
  /** Stops and discards. */
  cancel(): void;
}

export async function startRecording(): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This computer has no microphone API available.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((e) => { throw new Error(`The microphone could not be opened: ${(e as Error).message}`); });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stop: () => new Promise<Uint8Array>((resolve, reject) => {
      rec.onstop = async () => {
        release();
        try {
          const ctx = new AudioContext();
          const buf = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
          const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
          void ctx.close();
          resolve(toSpeechWav(channels, buf.sampleRate));
        } catch (e) { reject(new Error(`The recording could not be read: ${(e as Error).message}`)); }
      };
      if (rec.state === "inactive") rec.onstop(new Event("stop")); else rec.stop();
    }),
    cancel: () => { rec.onstop = null; try { if (rec.state !== "inactive") rec.stop(); } catch { /* already stopped */ } release(); },
  };
}
