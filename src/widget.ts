// Pure display helper for the live widget. Ported verbatim from
// opencode-ollama-cloud/plugin/tui-display.ts:8-12 — the format is ratified
// (wayfinder/prototipo-seccion-estadisticas.mock.md) and stays the string
// contract: the widget module only feeds it the omp-collected summary.

import type { SessionSummary } from "./stats.ts";

export function formatLiveLine(summary: SessionSummary | null): string {
  if (!summary || summary.steps === 0)
    return "— tok/s · TTFT — ms · Session average";
  return `${summary.avgTps.toFixed(1)} tok/s · TTFT ${Math.round(summary.avgTtftMs)} ms · Session average`;
}