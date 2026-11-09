// Analyse du spectre audio : le PCM envoyé à Discord (s16le, 48 kHz, stéréo) est découpé en
// images de 50 ms ; chaque image donne 32 barres (graves à gauche, aigus à droite), valeurs 0-255.

const SAMPLE_RATE = 48000;
const N = 1024;                    // taille de la FFT
const BANDS = 32;
const FRAME_MS = 50;
const FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000;
const FRAME_BYTES = FRAME_SAMPLES * 4;
const KEEP = 400;                  // images gardées en mémoire (20 s)

const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));

// Bornes des barres en « numéros de case » de la FFT, réparties en échelle logarithmique (40 Hz → 16 kHz).
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) =>
  40 * Math.pow(16000 / 40, i / BANDS) / (SAMPLE_RATE / N)
);

function fft(re, im) {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;

    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;

      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;

        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;

        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

const re = new Float64Array(N);
const im = new Float64Array(N);

function analyse(buf, offset) {
  for (let i = 0; i < N; i++) {
    const left = buf.readInt16LE(offset + i * 4);
    const right = buf.readInt16LE(offset + i * 4 + 2);
    re[i] = (left + right) / 65536 * HANN[i]; // mono, entre -1 et 1
    im[i] = 0;
  }

  fft(re, im);

  const bands = new Uint8Array(BANDS);

  for (let b = 0; b < BANDS; b++) {
    const lo = Math.max(1, Math.floor(EDGES[b]));
    const hi = Math.min(N / 2, Math.max(lo + 1, Math.ceil(EDGES[b + 1])));
    let peak = 0;

    for (let k = lo; k < hi; k++) {
      peak = Math.max(peak, Math.hypot(re[k], im[k]) / (N / 4)); // amplitude d'une sinusoïde = 1 pour pleine échelle
    }

    // décibels (plancher -70 dB), avec un léger relèvement des aigus, naturellement plus faibles
    const db = 20 * Math.log10(peak + 1e-6) + (b / BANDS) * 18;
    bands[b] = Math.round(Math.min(1, Math.max(0, (db + 70) / 70)) * 255);
  }

  return bands;
}

class Analyzer {
  constructor() {
    this.rest = Buffer.alloc(0);
    this.frames = new Map();
    this.count = 0;
  }

  push(chunk) {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let offset = 0;

    while (buf.length - offset >= FRAME_BYTES) {
      this.frames.set(this.count, analyse(buf, offset));
      this.frames.delete(this.count - KEEP);
      this.count++;
      offset += FRAME_BYTES;
    }

    this.rest = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
  }

  // Image correspondant à un temps de lecture (ms depuis le début de la ressource audio).
  at(timeMs) {
    return this.frames.get(Math.floor(timeMs / FRAME_MS)) || this.frames.get(this.count - 1) || null;
  }
}

module.exports = { Analyzer, BANDS };
