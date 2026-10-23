import { afterAll, describe, expect, it } from "vitest";
import { asBankId } from "../../src/shared-kernel/index.js";
import { HindsightEngine } from "../../src/retrieval/index.js";
import { retrievalEngineContract } from "./retrieval-engine.contract.js";

/**
 * Contract run against a live Hindsight (`npm run engines:hindsight:up`), gated like the paid
 * tests: RUN_ENGINE_TESTS=1 plus HINDSIGHT_BASE_URL (and HINDSIGHT_API_KEY when the server has
 * one). `npm run test:engines` sets the gate. Each test starts from purged banks under the test
 * prefix, so nothing here can touch the `mem-` banks a server uses. Verbatim retain still makes a
 * small LLM call per item (see the adapter), so this suite spends a few cents per run.
 */
const enabled = process.env.RUN_ENGINE_TESTS === "1" && Boolean(process.env.HINDSIGHT_BASE_URL);

(enabled ? describe : describe.skip)("HindsightEngine (live container)", () => {
  const make = () => {
    const engine = new HindsightEngine({
      baseUrl: process.env.HINDSIGHT_BASE_URL ?? "",
      ...(process.env.HINDSIGHT_API_KEY ? { apiKey: process.env.HINDSIGHT_API_KEY } : {}),
      bankPrefix: "memtest-",
    });
    return engine;
  };
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
    expect(engine.name).toBe("hindsight");
    expect(await engine.countBank(asBankId("bank-never-created"))).toBe(0);
  });
}, 300_000);
