// /ollama-recost: re-price the zero-cost ollama-cloud lines of every saved
// session, then drop omp-stats' incremental offsets for the rewritten files
// so the next dashboard sync re-parses them from scratch (its messages
// upsert updates the cost columns on conflict). Runs only on explicit user
// command — never on boot.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { fixSessionFileCosts, type CostRates } from "./cost-fix.ts";

export interface RecostResult {
  /** Session files rewritten. */
  files: number;
  /** Assistant lines re-priced (sum over files; omp-stats reports the same rows via its own upserts). */
  lines: number;
}

export interface RecostStatsDb {
  /** Drops incremental offsets for the given session files. */
  resetOffsets(sessionFiles: readonly string[]): number;
}

/** Reads ~/.omp/stats.db offsets. Swallows everything: the dashboard may not exist. */
export function createStatsOffsetReset(
  statsDbPath: string = join(homedir(), ".omp", "stats.db"),
): (sessionFiles: readonly string[]) => number {
  return (sessionFiles) => {
    if (sessionFiles.length === 0) return 0;
    try {
      const db = new Database(statsDbPath);
      try {
        const placeholders = sessionFiles.map(() => "?").join(",");
        const stmt = db.prepare(
          `DELETE FROM file_offsets WHERE session_file IN (${placeholders})`,
        );
        const result = stmt.run(...sessionFiles);
        return result.changes;
      } finally {
        db.close();
      }
    } catch {
      return 0;
    }
  };
}

/** Sessions root: ~/.omp/agent/sessions/<dir-slug>/*.jsonl. */
export function sessionFilesRoot(root: string = join(homedir(), ".omp", "agent", "sessions")): string[] {
  const files: string[] = [];
  let slugs: string[];
  try {
    slugs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return files;
  }
  for (const slug of slugs) {
    const dir = join(root, slug);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".jsonl")) files.push(join(dir, name));
    }
  }
  return files;
}

export interface RecostOptions {
  sessionsRoot?: string;
  readFileFn?: typeof readFileSync;
  writeFileFn?: typeof writeFileSync;
  resetOffsetsFn?: (sessionFiles: readonly string[]) => number;
}

/**
 * Re-prices every zero-cost ollama-cloud line across all saved sessions and
 * resets the corresponding omp-stats offsets. Never throws.
 */
export function recostAllSessions(
  ratesByModel: ReadonlyMap<string, CostRates>,
  opts: RecostOptions = {},
): RecostResult {
  const readFileFn = opts.readFileFn ?? readFileSync;
  const writeFileFn = opts.writeFileFn ?? writeFileSync;
  let files: string[];
  try {
    files = sessionFilesRoot(opts.sessionsRoot);
  } catch {
    files = [];
  }
  let filesPatched = 0;
  let linesPatched = 0;
  const rewritten: string[] = [];
  for (const file of files) {
    const before = fileSnapshot(file, readFileFn);
    if (before === null) continue;
    const beforeZero = countZeroCostLines(before);
    const outcome = fixSessionFileCosts(file, ratesByModel, readFileFn, writeFileFn);
    if (outcome !== "patched") continue;
    filesPatched++;
    const after = fileSnapshot(file, readFileFn);
    linesPatched += Math.max(0, beforeZero - countZeroCostLines(after ?? before));
    rewritten.push(file);
  }
  if (rewritten.length > 0) {
    try {
      opts.resetOffsetsFn?.(rewritten);
    } catch {
      // dashboard DB optional
    }
  }
  return { files: filesPatched, lines: linesPatched };
}

function fileSnapshot(file: string, readFileFn: typeof readFileSync): string | null {
  try {
    return readFileFn(file, "utf8");
  } catch {
    return null;
  }
}

const ZERO_COST_FINGERPRINT =
  '"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}';

function countZeroCostLines(content: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    if (line.includes(ZERO_COST_FINGERPRINT) && line.includes('"provider":"ollama-cloud"')) n++;
  }
  return n;
}

/** Dollars represented by the priced lines of a session file (for summaries). */
export function sessionFileCostTotal(
  file: string,
  readFileFn: typeof readFileSync = readFileSync,
): number {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of content.split("\n")) {
    if (!line.includes('"provider":"ollama-cloud"')) continue;
    try {
      const entry = JSON.parse(line) as { message?: { usage?: { cost?: { total?: number } } } };
      const totalCost = entry.message?.usage?.cost?.total;
      if (typeof totalCost === "number" && Number.isFinite(totalCost)) total += totalCost;
    } catch {
      continue;
    }
  }
  return total;
}
