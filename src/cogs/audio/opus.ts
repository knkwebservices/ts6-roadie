import OpusScript from 'opusscript';

/** 20 ms of 48 kHz stereo: 960 samples per channel. */
export const SAMPLES_PER_FRAME = 960;

export interface FrameEncoder {
  /** Encode exactly one 20 ms stereo s16le frame (3840 bytes). */
  encode(pcm: Buffer): Uint8Array;
  destroy(): void;
}

/**
 * Opus encoder. opusscript is WebAssembly, so there is nothing to compile on the
 * server (a native encoder is faster but needs build tools on Windows). This is the
 * only file that knows about it: swap the implementation here if you ever want to.
 */
export function createOpusEncoder(bitrate: number): FrameEncoder {
  const enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  enc.setBitrate(bitrate);
  return {
    encode: (pcm) => enc.encode(pcm, SAMPLES_PER_FRAME),
    destroy: () => enc.delete(),
  };
}
