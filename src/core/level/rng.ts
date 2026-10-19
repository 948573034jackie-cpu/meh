/**
 * Small deterministic PRNG for the level test: the same seed always yields the same items, the same
 * pseudowords and the same bootstrap interval, so a run can be reproduced from its stored seed.
 */

export type Rng = () => number;

/** FNV-1a over the string form of the seed, so string seeds and large numbers both work. */
export function hashSeed(seed: number | string): number {
  const s = typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed < 0x100000000 ? null : String(seed);
  if (s === null) return seed as number;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: fast, 32-bit state, good enough for shuffling and bootstraps. Returns floats in [0, 1). */
export function seededRng(seed: number | string): Rng {
  let a = hashSeed(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates on a copy. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}

/** Integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** A sample from Beta(a, b) via two gamma draws (Marsaglia–Tsang; a, b > 0). */
export function randBeta(rng: Rng, a: number, b: number): number {
  const x = randGamma(rng, a);
  const y = randGamma(rng, b);
  return x + y === 0 ? 0.5 : x / (x + y);
}

function randNormal(rng: Rng): number {
  let u = 0; let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randGamma(rng: Rng, shape: number): number {
  if (shape < 1) {
    // boost: Gamma(a) = Gamma(a + 1) * U^(1/a)
    const u = rng();
    return randGamma(rng, shape + 1) * Math.pow(u === 0 ? 1e-12 : u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number; let v: number;
    do { x = randNormal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u === 0 ? 1e-12 : u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
