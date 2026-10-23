/**
 * The estimators behind `eval:ci`, kept free of IO so they can be unit-tested (cluster.test.ts).
 *
 * Observations are 0/1 correctness tagged with their cluster (the conversation). With G clusters,
 * n observations and mean p̂:
 *   Var(p̂) = G/(G−1) · Σ_g ( Σ_{i∈g} (y_i − p̂) )² / n²        (Liang–Zeger sandwich, CR1 correction)
 *   CI     = p̂ ± t_{G−1, 0.975} · SE
 * For a paired difference d_i = y_i^X − y_i^Y over common questions the same estimator applies, and
 * the minimum detectable difference at 80% power is MDD = (t_{G−1,0.975} + t_{G−1,0.80}) · SE(d̄).
 * The MDD is retrospective (it uses the observed SE), so it describes what this design could have
 * detected, not the up-front number the plan asked for; a difference whose interval excludes zero
 * is reported as significant even when it is smaller than that MDD.
 * A cluster bootstrap (resample conversations with replacement; every one of the G^G ordered
 * resamples while G ≤ 6, otherwise 4000 seeded Monte Carlo draws) is computed beside it.
 */
import tQuantile from "@stdlib/stats-base-dists-t-quantile";
import mt19937 from "@stdlib/random-base-mt19937";

export interface Obs {
  readonly cluster: string;
  readonly y: number;
}

export interface Estimate {
  readonly n: number;
  readonly clusters: number;
  readonly mean: number;
  readonly se: number;
  readonly tCritical: number;
  readonly low: number;
  readonly high: number;
  readonly bootstrapLow: number;
  readonly bootstrapHigh: number;
  readonly bootstrapResamples: number;
}

function byCluster(obs: readonly Obs[]): number[][] {
  const m = new Map<string, number[]>();
  for (const o of obs) m.set(o.cluster, [...(m.get(o.cluster) ?? []), o.y]);
  return [...m.values()];
}

/** Cluster-robust mean with its t interval (clipped to `range`) and a cluster-bootstrap percentile interval. */
export function clusterRobust(obs: readonly Obs[], range: readonly [number, number] = [0, 1]): Estimate {
  const n = obs.length;
  const groups = byCluster(obs);
  const G = groups.length;
  const mean = n === 0 ? Number.NaN : obs.reduce((s, o) => s + o.y, 0) / n;
  let se = Number.NaN;
  let tCritical = Number.NaN;
  if (G >= 2) {
    const sumSq = groups.reduce((s, ys) => s + ys.reduce((a, y) => a + (y - mean), 0) ** 2, 0);
    se = Math.sqrt(((G / (G - 1)) * sumSq) / n ** 2);
    tCritical = tQuantile(0.975, G - 1);
  }
  const boot = clusterBootstrap(groups);
  return {
    n,
    clusters: G,
    mean,
    se,
    tCritical,
    low: Math.max(range[0], mean - tCritical * se),
    high: Math.min(range[1], mean + tCritical * se),
    bootstrapLow: boot.low,
    bootstrapHigh: boot.high,
    bootstrapResamples: boot.resamples,
  };
}

function clusterBootstrap(groups: readonly (readonly number[])[]): { low: number; high: number; resamples: number } {
  const G = groups.length;
  if (G < 2) return { low: Number.NaN, high: Number.NaN, resamples: 0 };
  const sums = groups.map((ys) => ys.reduce((a, b) => a + b, 0));
  const sizes = groups.map((ys) => ys.length);
  const means: number[] = [];
  const meanOf = (pick: readonly number[]): number => {
    let s = 0;
    let c = 0;
    for (const g of pick) {
      s += sums[g] ?? 0;
      c += sizes[g] ?? 0;
    }
    return c === 0 ? 0 : s / c;
  };
  if (G ** G <= 50_000) {
    const pick = new Array<number>(G).fill(0);
    const total = G ** G;
    for (let k = 0; k < total; k++) {
      let x = k;
      for (let j = 0; j < G; j++) {
        pick[j] = x % G;
        x = Math.floor(x / G);
      }
      means.push(meanOf(pick));
    }
  } else {
    const rand = mt19937.factory({ seed: 20261023 });
    for (let k = 0; k < 4_000; k++) means.push(meanOf(Array.from({ length: G }, () => rand() % G)));
  }
  means.sort((a, b) => a - b);
  // Nearest-rank percentile: the smallest value with at least p·N values at or below it.
  const at = (p: number): number => means[Math.min(means.length - 1, Math.max(0, Math.ceil(p * means.length) - 1))] ?? Number.NaN;
  return { low: at(0.025), high: at(0.975), resamples: means.length };
}

export interface PairedEstimate extends Estimate {
  /** (t_{G−1,0.975} + t_{G−1,0.80}) · SE: the smallest true difference this design detects with 80% power (retrospective). */
  readonly mdd: number;
  /** Whether the 95% interval excludes zero. */
  readonly significant: boolean;
}

/** Paired difference over observations already matched by question (d_i = x_i − y_i). */
export function pairedDifference(obs: readonly Obs[]): PairedEstimate {
  const est = clusterRobust(obs, [-1, 1]);
  const mdd = est.clusters >= 2 ? (tQuantile(0.975, est.clusters - 1) + tQuantile(0.8, est.clusters - 1)) * est.se : Number.NaN;
  const significant = Number.isFinite(est.low) && Number.isFinite(est.high) && (est.low > 0 || est.high < 0);
  return { ...est, mdd, significant };
}
