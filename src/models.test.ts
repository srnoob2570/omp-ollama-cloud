import { describe, expect, test } from "bun:test";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { toCatalogModel, type ArtifactModel } from "./catalog.ts";
import { toProviderModel } from "./models.ts";

const entry = (
  id: string,
  overrides: Partial<ArtifactModel> = {},
): ArtifactModel => ({
  id,
  name: "GLM 5.3 Flash",
  attachment: false,
  reasoning: true,
  tool_call: true,
  limit: { context: 1024 * 1024, output: 131072 },
  modalities: { input: ["text"] },
  release_date: "2026-08-14",
  x_ollama: { quantization: "FP8", reasoning_options: ["low", "high", "max"] },
  ...overrides,
});

// The normalization seam into omp's ProviderModelConfig: pricing maps to the
// four-slot cost block, reasoning_options to the effort thinking config, and
// modalities to the ("text" | "image") input union.
describe("toProviderModel", () => {
  test("official pricing on: glm-5.3-flash rate card feeds the cost block", () => {
    const catalog = toCatalogModel(
      entry("glm-5.3-flash", {
        cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
      }),
    );
    const model = toProviderModel(catalog, "on");
    expect(model.cost).toEqual({
      input: 0.15,
      output: 0.5,
      cacheRead: 0.03,
      cacheWrite: 0,
    });
  });

  test("pricing off zeroes the cost block", () => {
    const catalog = toCatalogModel(
      entry("glm-5.3-flash", {
        cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
      }),
    );
    expect(toProviderModel(catalog, "off").cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("rateless catalog entry (third-party) stays $0 in both modes", () => {
    const catalog = toCatalogModel(entry("glm-5.3"));
    expect(toProviderModel(catalog, "on").cost.input).toBe(0);
    expect(toProviderModel(catalog, "off").cost.input).toBe(0);
  });

  test("reasoning_options become the effort thinking config", () => {
    const catalog = toCatalogModel(entry("glm-5.3"));
    expect(toProviderModel(catalog).thinking).toEqual({
      mode: "effort",
      efforts: ["low", "high", "max"] as unknown as readonly Effort[],
    });
  });

  test("unknown effort keys are dropped, non-reasoning model gets no thinking", () => {
    const dirty = toCatalogModel(
      entry("glm-5.3", {
        x_ollama: { reasoning_options: ["low", "ultra", "absurd"] },
      }),
    );
    expect(toProviderModel(dirty).thinking?.efforts).toEqual([
      "low",
    ] as unknown as readonly Effort[]);
    const plain = toCatalogModel(
      entry("gemma4:31b", {
        reasoning: false,
        x_ollama: {},
      }),
    );
    expect(toProviderModel(plain).thinking).toBeUndefined();
    expect(toProviderModel(plain).reasoning).toBe(false);
  });

  test("modalities map to the input union with a text fallback", () => {
    const vision = toProviderModel(
      toCatalogModel(
        entry("gemma4:31b", {
          attachment: true,
          modalities: { input: ["text", "image", "audio"] },
        }),
      ),
    );
    expect(vision.input).toEqual(["text", "image"]);
    const bare = toProviderModel(
      toCatalogModel(
        entry("glm-5.3", { modalities: { input: ["audio"] } }),
      ),
    );
    expect(bare.input).toEqual(["text"]);
  });

  test("limits pass through", () => {
    const model = toProviderModel(toCatalogModel(entry("glm-5.3")));
    expect(model.contextWindow).toBe(1024 * 1024);
    expect(model.maxTokens).toBe(131072);
  });
});