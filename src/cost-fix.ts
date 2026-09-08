// Plugin-side workaround for the omp ollama-chat adapter bug: the adapter
// fills usage counts (prompt_eval_count / eval_count) but never prices them
// (no Va(model, usage) call, unlike every other adapter), so sessions persist
// usage.cost = $0 and every cost consumer downstream (status line, /usage,
// omp-stats dashboard) reports $0 for ollama-cloud requests.
//
// omp hands extensions only a deep-cloned snapshot at message_end, and it
// defers the session-file write to the turn flush, so the fix runs at
// agent_end: re-price every ollama-cloud assistant line whose cost block is
// still $0. Line lengths may change; omp's writer is append-only (no byte
// offsets), and its in-memory copy is only re-serialized on a full rewrite
// (session move / compaction), which would overwrite the patch with the
// in-memory $0 — accepted degradation, the upstream fix makes this module a
// no-op (it only patches lines whose cost.total is exactly 0).

import { readFileSync, writeFileSync } from "node:fs";

export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostPatchUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  cost?: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    total?: unknown;
  };
}

const countToken = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** omp's wVe pricing: rate (USD per 1M) × tokens / 1e6. */
export function priceUsage(rates: CostRates, usage: CostPatchUsage): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
} {
  const input = (rates.input / 1e6) * countToken(usage.input);
  const output = (rates.output / 1e6) * countToken(usage.output);
  const cacheRead = (rates.cacheRead / 1e6) * countToken(usage.cacheRead);
  const cacheWrite = (rates.cacheWrite / 1e6) * countToken(usage.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

export type CostFixOutcome = "patched" | "not-found" | "unavailable";
export function fixSessionFileCosts(
  sessionFile: string | undefined,
  ratesByModel: ReadonlyMap<string, CostRates>,
  readFileFn: typeof readFileSync = readFileSync,
  writeFileFn: typeof writeFileSync = writeFileSync,
): CostFixOutcome {
  if (!sessionFile || ratesByModel.size === 0) return "unavailable";
  let content: string;
  try {
    content = readFileFn(sessionFile, "utf8");
  } catch {
    return "unavailable";
  }
  const lines = content.split("\n");
  let patched = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes('"provider":"ollama-cloud"')) continue;
    if (!line.includes('"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const entryObj = entry as { [k: string]: unknown };
    if (entryObj.type !== "message") continue;
    const message = entryObj.message as { [k: string]: unknown } | undefined;
    if (!message || typeof message !== "object") continue;
    if (message.role !== "assistant") continue;
    if (message.provider !== "ollama-cloud") continue;
    const modelId = message.model;
    if (typeof modelId !== "string") continue;
    const rates = ratesByModel.get(modelId);
    if (!rates) continue;
    const usage = message.usage as { [k: string]: unknown } | undefined;
    if (!usage || typeof usage !== "object") continue;
    if (countToken(usage.totalTokens) === 0) continue;
    const cost = usage.cost as { [k: string]: unknown } | undefined;
    if (!cost || typeof cost !== "object" || countToken(cost.total) !== 0) continue;
    usage.cost = priceUsage(rates, usage);
    lines[i] = JSON.stringify(entry);
    patched++;
  }
  if (patched === 0) return "not-found";
  try {
    writeFileFn(sessionFile, lines.join("\n"), "utf8");
  } catch {
    return "unavailable";
  }
  return "patched";
}
