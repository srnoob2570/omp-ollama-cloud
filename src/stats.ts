// Streaming stats (TTFT / TPS) measured from omp's own AssistantMessage
// timing: every AssistantMessage carries duration (request → stream end) and
// ttft (request → first token), so no wire interception is needed. Ported
// from opencode-ollama-cloud/plugin/stats.ts: only the pure measurement core
// survives — omp's message_end event already provides the gating that
// opencode needed the wire-capture + claim machinery for (task subagents run
// in their own runners without extensions; title generation and
// auto-thinking emit no message_end into the main runner; compaction
// produces a compaction entry, not an assistant message).
//
// Glossary (CONTEXT.md): a unit is an *LLM step* (each streaming completion);
// the *session average* is token-weighted TPS + simple-mean TTFT across
// main-thread steps only — no per-model breakdown, never persisted.

/** One measured LLM step. In-memory per session, never persisted. */
export interface StepMeasurement {
  modelID: string;
  /** Request sent → first token. */
  ttftMs: number;
  /** Output tokens including reasoning (omp's usage.output semantics). */
  tokensOut: number;
  /** First token → stream end. */
  decodeMs: number;
  /** Wall-clock start of the request (ms since epoch). */
  ts: number;
}

/** Aggregates the live widget line read. */
export interface SessionSummary {
  steps: number;
  tokensOutTotal: number;
  decodeMsTotal: number;
  /** Token-weighted: total output tokens over total decode time (tok/s). */
  avgTps: number;
  /** Simple mean per step (latency is a time, not a volume). */
  avgTtftMs: number;
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** Session average per the ratified contract: weighted TPS, simple-mean TTFT. */
export function summarize(steps: readonly StepMeasurement[]): SessionSummary {
  const tokensOutTotal = steps.reduce((a, s) => a + s.tokensOut, 0);
  const decodeMsTotal = steps.reduce((a, s) => a + s.decodeMs, 0);
  return {
    steps: steps.length,
    tokensOutTotal,
    decodeMsTotal,
    avgTps: decodeMsTotal === 0 ? 0 : tokensOutTotal / (decodeMsTotal / 1000),
    avgTtftMs: mean(steps.map((s) => s.ttftMs)),
  };
}