// Seeded randomness: every generated catalog, covariance and scenario is reproducible from its seed.

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = ReturnType<typeof rng>;

export function rng(seed: number) {
  const u = mulberry32(seed);
  const r = {
    u,
    range: (a: number, b: number) => a + (b - a) * u(),
    int: (a: number, b: number) => Math.floor(a + (b - a + 1) * u()),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(u() * xs.length)],
    normal: (m = 0, s = 1) => m + s * Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()),
  };
  return r;
}
