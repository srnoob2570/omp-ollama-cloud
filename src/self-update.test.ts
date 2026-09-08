import { describe, expect, test } from "bun:test";
import {
  compareSemver,
  decideUpdate,
  parseModuleOrigin,
} from "./self-update.ts";
import { summarize, type StepMeasurement } from "./stats.ts";
import { formatLiveLine } from "./widget.ts";

describe("parseModuleOrigin", () => {
  test("npm install under ~/.omp/plugins/node_modules is npm", () => {
    const origin = parseModuleOrigin(
      "/home/u/.omp/plugins/node_modules/@srnoob2570/omp-ollama-cloud/src/index.ts",
      "/home/u/.omp/plugins",
    );
    expect(origin).toEqual({
      source: "npm",
      pluginsRoot: "/home/u/.omp/plugins",
    });
  });

  test("a repo checkout (omp plugin link) is dev", () => {
    expect(
      parseModuleOrigin(
        "/home/u/Documentos/omp-ollama-cloud/src/index.ts",
        "/home/u/.omp/plugins",
      ),
    ).toEqual({ source: "dev" });
    expect(parseModuleOrigin("", "/home/u/.omp/plugins")).toBeNull();
  });
});

describe("compareSemver", () => {
  test("orders and rejects non-versions", () => {
    expect(compareSemver("0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "0.2.0")).toBe(-1);
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("abc", "0.1.0")).toBeNull();
  });
});

describe("decideUpdate", () => {
  test("update only when npm, resolvable, and strictly newer", () => {
    expect(
      decideUpdate({ installed: "0.1.0", latest: "0.2.0", isNpm: true }),
    ).toEqual({ action: "update", latest: "0.2.0" });
    expect(
      decideUpdate({ installed: "0.2.0", latest: "0.1.0", isNpm: true }),
    ).toEqual({ action: "none" });
    expect(
      decideUpdate({ installed: "0.1.0", latest: null, isNpm: true }),
    ).toEqual({ action: "none" });
    expect(
      decideUpdate({ installed: "0.1.0", latest: "0.2.0", isNpm: false }),
    ).toEqual({ action: "none" });
  });
});

// The measurement core: token-weighted TPS, simple-mean TTFT (ratified
// contract, opencode port).
describe("summarize + formatLiveLine", () => {
  const step = (
    tokensOut: number,
    decodeMs: number,
    ttftMs: number,
  ): StepMeasurement => ({
    modelID: "glm-5.3-flash",
    tokensOut,
    decodeMs,
    ttftMs,
    ts: 0,
  });

  test("empty summary renders the placeholder", () => {
    expect(formatLiveLine(summarize([]))).toBe("— tok/s · TTFT — ms");
  });

  test("weighted TPS over steps, mean TTFT, live line format", () => {
    const summary = summarize([step(100, 2000, 300), step(100, 1000, 500)]);
    expect(summary.avgTps).toBeCloseTo(100 / 1.5, 5);
    expect(summary.avgTtftMs).toBe(400);
    expect(summary.steps).toBe(2);
    expect(formatLiveLine(summary)).toBe("66.7 tok/s · TTFT 400 ms");
  });
});