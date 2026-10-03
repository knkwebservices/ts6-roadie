import { deflateSync, inflateSync } from 'node:zlib';
import { BANNER_FONT_CODES, BANNER_FONTS } from './bannerfont.js';

/**
 * The stats banner: a PNG drawn by the bot itself (no image libraries), for the TeamSpeak host banner
 * or a website. Plain RGB pixels, two built-in font sizes, and a tiny PNG encoder.
 */

export const BANNER_WIDTH = 800;
export const BANNER_HEIGHT = 160;

export interface BannerValues {
  title: string;
  online: number;
  record: number;
  /** What is playing, or empty. */
  song: string;
  /** Already formatted, like "Sat 9:41 PM". */
  clock: string;
}

type Rgb = [number, number, number];

interface Font {
  lineHeight: number;
  glyphs: Map<number, { width: number; alpha: Uint8Array }>;
}

const fonts = new Map<'large' | 'small', Font>();

function font(which: 'large' | 'small'): Font {
  const have = fonts.get(which);
  if (have) return have;
  const raw = inflateSync(Buffer.from(BANNER_FONTS[which], 'base64'));
  const lineHeight = raw.readUInt16LE(2);
  const count = raw.readUInt16LE(5);
  const widths = raw.subarray(7, 7 + count);
  const glyphs = new Map<number, { width: number; alpha: Uint8Array }>();
  let at = 7 + count;
  for (let i = 0; i < count; i++) {
    const w = widths[i]!;
    const size = w * lineHeight;
    glyphs.set(BANNER_FONT_CODES[i]!, { width: w, alpha: raw.subarray(at, at + size) });
    at += size;
  }
  const f = { lineHeight, glyphs };
  fonts.set(which, f);
  return f;
}

const glyphFor = (f: Font, ch: string): { width: number; alpha: Uint8Array } => f.glyphs.get(ch.codePointAt(0) ?? 63) ?? f.glyphs.get(63)!;

export function measure(text: string, which: 'large' | 'small'): number {
  const f = font(which);
  let w = 0;
  for (const ch of text) w += glyphFor(f, ch).width;
  return w;
}

/** Shorten text with "..." so it fits in `max` pixels. */
export function fit(text: string, which: 'large' | 'small', max: number): string {
  if (measure(text, which) <= max) return text;
  const chars = [...text];
  while (chars.length && measure(`${chars.join('').trimEnd()}...`, which) > max) chars.pop();
  return chars.length ? `${chars.join('').trimEnd()}...` : '';
}

class Canvas {
  readonly px: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Uint8Array(w * h * 3);
  }

  blend(x: number, y: number, c: Rgb, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 3;
    for (let k = 0; k < 3; k++) this.px[i + k] = Math.round(this.px[i + k]! + (c[k]! - this.px[i + k]!) * Math.min(1, a));
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb, a = 1): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) this.blend(xx, yy, c, a);
  }

  text(s: string, x: number, y: number, which: 'large' | 'small', c: Rgb): number {
    const f = font(which);
    let cx = x;
    for (const ch of s) {
      const g = glyphFor(f, ch);
      for (let gy = 0; gy < f.lineHeight; gy++) {
        for (let gx = 0; gx < g.width; gx++) {
          const a = g.alpha[gy * g.width + gx]!;
          if (a) this.blend(cx + gx, y + gy, c, a / 255);
        }
      }
      cx += g.width;
    }
    return cx;
  }
}

// ---- PNG ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(rows, y * (w * 3 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}

// ---- the banner ----

const BG_TOP: Rgb = [16, 22, 40];
const BG_BOTTOM: Rgb = [9, 12, 24];
const WHITE: Rgb = [240, 244, 250];
const MUTED: Rgb = [150, 162, 186];
const TEAL: Rgb = [45, 212, 191];
const ORANGE: Rgb = [249, 140, 46];

export function renderBanner(v: BannerValues): Buffer {
  const W = BANNER_WIDTH;
  const H = BANNER_HEIGHT;
  const c = new Canvas(W, H);
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    c.rect(0, y, W, 1, [0, 1, 2].map((k) => Math.round(BG_TOP[k]! + (BG_BOTTOM[k]! - BG_TOP[k]!) * t)) as Rgb);
  }
  // equalizer bars along the bottom, fixed so the image only changes when the numbers do
  for (let i = 0, x = 4; x < W; i++, x += 14) {
    const bh = 10 + ((i * 37) % 23);
    c.rect(x, H - bh, 8, bh, TEAL, 0.12);
  }
  c.rect(28, 26, 6, H - 52, ORANGE);

  const left = 52;
  const right = W - 28;
  c.text(fit(v.title || 'TeamSpeak', 'large', right - left - 190), left, 18, 'large', WHITE);
  // the clock, top right
  const clock = fit(v.clock, 'small', 180);
  c.text(clock, right - measure(clock, 'small'), 26, 'small', MUTED);

  // online and record
  let x = c.text('Online ', left, 70, 'small', MUTED);
  x = c.text(String(v.online), x, 70, 'small', TEAL);
  x = c.text('   Record ', x, 70, 'small', MUTED);
  c.text(String(v.record), x, 70, 'small', WHITE);

  // now playing
  const label = v.song ? 'Now playing  ' : '';
  const lx = c.text(label, left, 104, 'small', MUTED);
  c.text(fit(v.song || 'Nothing playing right now', 'small', right - lx), lx, 104, 'small', v.song ? ORANGE : MUTED);
  return encodePng(W, H, c.px);
}
