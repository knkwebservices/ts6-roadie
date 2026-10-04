import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { killTree } from '../audio/proc.js';

/** How long a voice engine may take to say one message. */
const SYNTH_TIMEOUT_MS = 20_000;
/** The longest speech the bot will play from one message (protects against a stuck engine filling memory). */
const MAX_PCM_BYTES = 48_000 * 2 * 2 * 60; // one minute

export type TtsEngine = 'windows' | 'piper';

export interface SynthOptions {
  engine: TtsEngine;
  /** Windows voice name (empty = the system default). */
  voice: string;
  /** Windows speaking rate, -10 (slow) to 10 (fast). */
  rate: number;
  piperPath: string;
  piperModel: string;
  ffmpegPath: string;
  /** A temporary .wav file to use; it is removed afterwards. */
  wavFile: string;
}

/**
 * Text is handed to PowerShell through an environment variable, never in the command line, so nothing
 * anyone types can be run as a command.
 */
const WINDOWS_SPEAK = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:ROADIE_TTS_VOICE) { $s.SelectVoice($env:ROADIE_TTS_VOICE) }',
  '$s.Rate = [int]$env:ROADIE_TTS_RATE',
  '$s.SetOutputToWaveFile($env:ROADIE_TTS_OUT)',
  '$s.Speak($env:ROADIE_TTS_TEXT)',
  '$s.Dispose()',
].join('; ');

const WINDOWS_VOICES = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }',
  '$s.Dispose()',
].join('; ');

function run(cmd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number } = {}): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: opts.env ?? process.env });
    } catch (e) {
      return reject(e);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child);
      reject(new Error(`${cmd} took too long`));
    }, opts.timeoutMs ?? SYNTH_TIMEOUT_MS);
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${cmd} was not found`) : e);
    });
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (opts.maxBytes && size > opts.maxBytes) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          killTree(child);
          reject(new Error('the speech came out too long'));
        }
        return;
      }
      chunks.push(d);
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-400)));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks), err });
    });
  });
}

const firstLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? '';

/** Turn text into 48 kHz 16-bit stereo PCM, ready for the audio player. */
export async function synthesize(text: string, o: SynthOptions): Promise<Buffer> {
  try {
    if (o.engine === 'piper') {
      if (!o.piperModel) throw new Error('no Piper voice model is set (tts.piperModel)');
      const r = await run(o.piperPath, ['--model', o.piperModel, '--output_file', o.wavFile], { input: text });
      if (r.code !== 0) throw new Error(`Piper failed: ${firstLine(r.err) || `exit code ${r.code}`}`);
    } else {
      if (process.platform !== 'win32') throw new Error('Windows voices only work when the bot runs on Windows. Use the Piper engine instead.');
      const env = { ...process.env, ROADIE_TTS_TEXT: text, ROADIE_TTS_OUT: o.wavFile, ROADIE_TTS_VOICE: o.voice, ROADIE_TTS_RATE: String(o.rate) };
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SPEAK], { env });
      if (r.code !== 0) throw new Error(`Windows speech failed: ${firstLine(r.err) || `exit code ${r.code}`}`);
    }
    const pcm = await run(o.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', o.wavFile, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { maxBytes: MAX_PCM_BYTES });
    if (pcm.code !== 0 || !pcm.out.length) throw new Error(`ffmpeg could not read the speech: ${firstLine(pcm.err) || 'no audio'}`);
    return pcm.out;
  } finally {
    await rm(o.wavFile, { force: true }).catch(() => {});
  }
}

/** The Windows voices installed on this computer. */
export async function windowsVoices(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_VOICES], { timeoutMs: 15_000 });
  return r.out
    .toString('utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Bring speech up to a steady loudness: voice engines often come out much quieter than music, so the
 * loudest point is raised to about 90% of full scale (never boosted more than 6 times, so silence stays silent).
 */
export function normalizePcm(pcm: Buffer): Buffer {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  if (peak === 0) return pcm;
  return scalePcm(pcm, Math.min(6, 29_500 / peak));
}

/** Scale PCM (16-bit) by `gain`, in place. */
export function scalePcm(pcm: Buffer, gain: number): Buffer {
  if (gain === 1) return pcm;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.round(pcm.readInt16LE(i) * gain);
    pcm.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i);
  }
  return pcm;
}
