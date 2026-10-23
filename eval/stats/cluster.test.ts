import { describe, expect, it } from "vitest";
import { clusterRobust, pairedDifference, type Obs } from "./cluster.js";

const obs = (clusters: readonly (readonly number[])[]): Obs[] => clusters.flatMap((ys, g) => ys.map((y) => ({ cluster: `c${g}`, y })));

describe("cluster-robust estimators", () => {
  it("reproduces the sandwich variance by hand for two clusters", () => {
    // Cluster 0: 1,1,0 (sum 2); cluster 1: 1,0,0 (sum 1). n = 6, p̂ = 0.5.
    // Residual sums: 2 − 1.5 = 0.5 and 1 − 1.5 = −0.5; Σ(...)² = 0.5; Var = 2/1 · 0.5 / 36 = 1/36.
    const e = clusterRobust(obs([[1, 1, 0], [1, 0, 0]]));
    expect(e.n).toBe(6);
    expect(e.clusters).toBe(2);
    expect(e.mean).toBeCloseTo(0.5);
    expect(e.se).toBeCloseTo(1 / 6);
    expect(e.tCritical).toBeCloseTo(12.706, 2); // t_{1, 0.975}
    expect(e.low).toBe(0); // clipped to the proportion's range
    expect(e.high).toBe(1);
  });

  it("has no interval with fewer than two clusters and clips to [0, 1]", () => {
    const e = clusterRobust(obs([[1, 0, 1]]));
    expect(e.clusters).toBe(1);
    expect(Number.isNaN(e.se)).toBe(true);
    expect(Number.isNaN(e.low)).toBe(true);
    expect(e.bootstrapResamples).toBe(0);
    expect(Number.isNaN(clusterRobust([]).mean)).toBe(true);
  });

  it("enumerates every ordered resample exactly for small G", () => {
    // Three clusters with means 1, 0, 0.5 and equal sizes: 27 resamples; the pooled mean is the average of the picked cluster means.
    const e = clusterRobust(obs([[1, 1], [0, 0], [1, 0]]));
    expect(e.bootstrapResamples).toBe(27);
    expect(e.bootstrapLow).toBeCloseTo(0); // picking cluster 1 three times
    expect(e.bootstrapHigh).toBeCloseTo(1); // picking cluster 0 three times
  });

  it("paired difference: zero variance gives a zero MDD, a consistent lead is significant only with enough clusters", () => {
    const same = pairedDifference(obs([[0, 0], [0, 0], [0, 0], [0, 0]]));
    expect(same.mean).toBe(0);
    expect(same.mdd).toBe(0);
    expect(same.significant).toBe(false);

    // Arm X beats Y on one question per conversation in four conversations of three questions: d = 1/3 in every cluster, so no between-cluster variance.
    const lead = pairedDifference(obs([[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]]));
    expect(lead.mean).toBeCloseTo(1 / 3);
    expect(lead.se).toBeCloseTo(0);
    expect(lead.significant).toBe(true);

    // Mixed clusters: wide interval, not significant, MDD larger than the observed difference.
    const mixed = pairedDifference(obs([[1, 0, 0], [0, 0, 0], [0, 0, -1], [1, 1, 0]]));
    expect(mixed.clusters).toBe(4);
    expect(mixed.tCritical).toBeCloseTo(3.182, 2);
    expect(mixed.significant).toBe(false);
    expect(mixed.mdd).toBeGreaterThan(Math.abs(mixed.mean));
    expect(mixed.low).toBeGreaterThanOrEqual(-1);
    expect(mixed.high).toBeLessThanOrEqual(1);
  });
});
