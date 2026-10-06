export const n = (x: number) => x.toLocaleString("en-US");
export const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const usd = (x: number) => (x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(4)}`);
