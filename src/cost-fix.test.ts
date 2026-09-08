import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { fixSessionFileCosts, priceUsage, type CostRates } from "./cost-fix.ts";

const RATES: CostRates = { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 };
const RATES_BY_MODEL = new Map([["glm-5.3-flash", RATES]]);

const sessionLine = (over: {
  model?: string;
  provider?: string;
  totalTokens: number;
  input: number;
  output: number;
  total?: number;
}): string =>
  JSON.stringify({
    type: "message",
    id: "e1",
    message: {
      role: "assistant",
      provider: over.provider ?? "ollama-cloud",
      model: over.model ?? "glm-5.3-flash",
      usage: {
        input: over.input,
        output: over.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: over.totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: over.total ?? 0 },
      },
    },
  });

const tmpSession = (lines: string[]): string => {
  const dir = mkdtempSync(join(osTmpdir(), "cost-fix-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
};

const costs = (file: string): Array<Record<string, number>> =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.includes("ollama-cloud"))
    .map((l) => JSON.parse(l).message.usage.cost);

describe("priceUsage", () => {
  test("rates are USD per 1M tokens", () => {
    const priced = priceUsage(RATES, { input: 2_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
    expect(priced.input).toBeCloseTo(0.3, 10);
    expect(priced.output).toBeCloseTo(0.5, 10);
    expect(priced.total).toBeCloseTo(0.8, 10);
  });

  test("non-finite and negative counts price as zero", () => {
    const priced = priceUsage(RATES, { input: -5, output: Number.NaN, cacheRead: undefined, cacheWrite: 0 });
    expect(priced.total).toBe(0);
  });
});

describe("fixSessionFileCosts", () => {
  test("patches zero-cost ollama-cloud lines in place", () => {
    const file = tmpSession([sessionLine({ totalTokens: 23735, input: 23715, output: 20 })]);
    expect(fixSessionFileCosts(file, RATES_BY_MODEL)).toBe("patched");
    const [cost] = costs(file);
    expect(cost.input).toBeCloseTo((0.15 / 1e6) * 23715, 12);
    expect(cost.output).toBeCloseTo((0.5 / 1e6) * 20, 12);
    expect(cost.total).toBeCloseTo(cost.input + cost.output, 12);
  });

  test("refuses lines whose cost total is already non-zero", () => {
    const file = tmpSession([sessionLine({ totalTokens: 100, input: 80, output: 20, total: 0.01 })]);
    expect(fixSessionFileCosts(file, RATES_BY_MODEL)).toBe("not-found");
    expect(costs(file)[0].total).toBe(0.01);
  });

  test("skips models without known rates", () => {
    const file = tmpSession([sessionLine({ model: "kimi-k3", totalTokens: 100, input: 80, output: 20 })]);
    expect(fixSessionFileCosts(file, RATES_BY_MODEL)).toBe("not-found");
    expect(costs(file)[0].total).toBe(0);
  });

  test("patches every unpriced line with known rates, leaves others", () => {
    const file = tmpSession([
      sessionLine({ totalTokens: 10, input: 5, output: 5 }),
      sessionLine({ model: "glm-5.3", totalTokens: 20, input: 10, output: 10 }),
      sessionLine({ totalTokens: 30, input: 20, output: 10 }),
    ]);
    expect(fixSessionFileCosts(file, new Map(RATES_BY_MODEL).set("glm-5.3", RATES))).toBe("patched");
    const [first, second, third] = costs(file);
    expect(first.total).toBeGreaterThan(0);
    expect(second.total).toBeGreaterThan(0);
    expect(third.total).toBeGreaterThan(0);
  });

  test("different provider does not match", () => {
    const file = tmpSession([sessionLine({ provider: "openai", totalTokens: 100, input: 80, output: 20 })]);
    expect(fixSessionFileCosts(file, RATES_BY_MODEL)).toBe("not-found");
    expect(costs(file).length).toBe(0);
  });

  test("missing session file is unavailable, never throws", () => {
    expect(fixSessionFileCosts("/nonexistent/x.jsonl", RATES_BY_MODEL)).toBe("unavailable");
  });

  test("all-zero rates skip the file entirely", () => {
    const file = tmpSession([sessionLine({ totalTokens: 100, input: 80, output: 20 })]);
    expect(
      fixSessionFileCosts(file, new Map([["glm-5.3-flash", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]])),
    ).toBe("patched");
    expect(costs(file)[0].total).toBe(0);
  });

  test("undefined session path is unavailable", () => {
    expect(fixSessionFileCosts(undefined, RATES_BY_MODEL)).toBe("unavailable");
  });
});