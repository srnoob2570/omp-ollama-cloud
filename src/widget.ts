// Pure display helper for the live widget. Ported from
// opencode-ollama-cloud/plugin/tui-display.ts:8-12, suffix trimmed at user
// request: the widget module only feeds it the omp-collected summary.

import type { SessionSummary } from "./stats.ts";

export function formatLiveLine(summary: SessionSummary | null): string {
  if (!summary || summary.steps === 0)
    return "— tok/s · TTFT — ms";
  return `${summary.avgTps.toFixed(1)} tok/s · TTFT ${Math.round(summary.avgTtftMs)} ms`;
}