import { afterAll, describe, expect, it } from "vitest";
import { asBankId } from "../../src/shared-kernel/index.js";
import { HonchoEngine } from "../../src/retrieval/index.js";
import { retrievalEngineContract } from "./retrieval-engine.contract.js";

/**
 * Contract run against a live Honcho (`npm run engines:honcho:up`, admin token in HONCHO_API_KEY),
 * gated like the paid tests: RUN_ENGINE_TESTS=1 plus HONCHO_BASE_URL. `npm run test:engines` sets
 * the gate. Each test starts from purged workspaces under the test prefix; Honcho deletes
 * asynchronously, so a purge may take a few seconds. Embedding each message costs a fraction of a cent.
 */
const enabled = process.env.RUN_ENGINE_TESTS === "1" && Boolean(process.env.HONCHO_BASE_URL);

(enabled ? describe : describe.skip)("HonchoEngine (live container)", () => {
  const make = () =>
    new HonchoEngine({
      baseUrl: process.env.HONCHO_BASE_URL ?? "",
      ...(process.env.HONCHO_API_KEY ? { apiKey: process.env.HONCHO_API_KEY } : {}),
      workspacePrefix: "memtest-",
    });
  const fresh = async () => {
    const engine = make();
    for (const b of ["bank-a", "bank-b"]) {
      const r = await engine.purgeBank(asBankId(b));
      if (r.remaining !== 0) throw new Error(`could not purge ${b} before the test`);
    }
    return engine;
  };
  afterAll(async () => {
    const engine = make();
    for (const b of ["bank-a", "bank-b"]) await engine.purgeBank(asBankId(b));
  });

  retrievalEngineContract(fresh);

  it("names itself for the erasure receipt and reports zero for a bank it never saw", async () => {
    const engine = make();
    expect(engine.name).toBe("honcho");
    expect(await engine.countBank(asBankId("bank-never-created"))).toBe(0);
  });
}, 300_000);
