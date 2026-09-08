// CatalogModel → omp ProviderModelConfig. New normalizer: omp's shape
// (ProviderModelConfig in @oh-my-pi/pi-coding-agent extensions) is unrelated
// to opencode's ModelV2, so the opencode toModelV2 could not be ported.

import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { CatalogModel } from "./catalog.ts";

const VALID_EFFORTS: readonly Effort[] = [
  Effort.Minimal,
  Effort.Low,
  Effort.Medium,
  Effort.High,
  Effort.XHigh,
  Effort.Max,
];

export function toProviderModel(
  m: CatalogModel,
  pricing: "off" | "on" = "on",
): ProviderModelConfig {
  const input = m.input.filter((v) => v === "text" || v === "image");
  // prices are USD per 1M tokens — omp's cost contract. The official Ollama
  // Cloud rate is opt-out: default on, `pricing: "off"` keeps the counter at
  // $0.00. A model without a cost entry (third-party catalogs) stays at $0
  // in both modes (no partial estimates). cachedInput feeds cacheRead;
  // cacheWrite stays 0 — the rate card publishes no cache-write column.
  const official = pricing === "on" ? m.cost : undefined;
  const efforts = m.reasoningOptions.filter(
    (e): e is Effort => (VALID_EFFORTS as readonly string[]).includes(e),
  );
  const model: ProviderModelConfig = {
    id: m.id,
    name: m.name,
    reasoning: m.capabilities.thinking,
    input: input.length > 0 ? input : ["text"],
    cost: {
      input: official?.input ?? 0,
      output: official?.output ?? 0,
      cacheRead: official?.cachedInput ?? 0,
      cacheWrite: 0,
    },
    contextWindow: m.context,
    maxTokens: m.maxOutput,
  };
  if (efforts.length > 0) {
    model.thinking = { mode: "effort", efforts };
  }
  return model;
}