import { spawn, type ChildProcess } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

/**
 * Kill a child and everything it spawned. On Windows the standalone yt-dlp.exe starts a
 * second process, and a plain kill() would leave that one running and downloading.
 */
export function killTree(child: ChildProcess | undefined): void {
  if (!child || !child.pid || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  } else {
    child.kill('SIGKILL');
  }
}

/** Run a short-lived command and collect its output. Never uses a shell. */
export const runProcess: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      reject(new Error(`${cmd} timed out after ${Math.round((opts.timeoutMs ?? 45_000) / 1000)}s`));
    }, opts.timeoutMs ?? 45_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < 8_000_000) stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 200_000) stderr += d;
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
