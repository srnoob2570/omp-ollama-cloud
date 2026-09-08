import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  recostAllSessions,
  sessionFilesRoot,
  createStatsOffsetReset,
  type RecostOptions,
} from "./recost.ts";
import type { CostRates } from "./cost-fix.ts";

const RATES: CostRates = { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 };
const RATES_BY_MODEL = new Map([["glm-5.3-flash", RATES]]);

const zeroCostLine = (model = "glm-5.3-flash", input = 1000, output = 20): string =>
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      provider: "ollama-cloud",
      model,
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });

const pricedLine = (total: number): string => zeroCostLine().replace(/"total":0\}/, `"total":${total}}`);

interface TempSessions {
  root: string;
  add: (slug: string, name: string, content: string) => string;
}

const tempSessions = (): TempSessions => {
  const root = mkdtempSync(join(osTmpdir(), "recost-"));
  return {
    root,
    add: (slug, name, content) => {
      mkdirSync(join(root, slug), { recursive: true });
      const file = join(root, slug, name);
      writeFileSync(file, content + "\n");
      return file;
    },
  };
};

const costTotals = (file: string): number[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).message.usage.cost.total as number);

describe("sessionFilesRoot", () => {
  test("collects .jsonl files across slug directories, ignoring others", () => {
    const t = tempSessions();
    t.add("slug-a", "s1.jsonl", zeroCostLine());
    t.add("slug-b", "s2.jsonl", zeroCostLine());
    t.add("slug-b", "notes.txt", "not a session");
    const files = sessionFilesRoot(t.root);
    expect(files.filter((f) => f.endsWith(".jsonl")).length).toBe(2);
    expect(files.some((f) => f.endsWith(".txt"))).toBe(false);
  });

  test("missing root returns empty without throwing", () => {
    expect(sessionFilesRoot("/nonexistent/root")).toEqual([]);
  });
});

describe("recostAllSessions", () => {
  test("re-prices all sessions and reports counts", () => {
    const t = tempSessions();
    const f1 = t.add("slug-a", "s1.jsonl", [zeroCostLine(), zeroCostLine()].join("\n"));
    const f2 = t.add("slug-b", "s2.jsonl", zeroCostLine("glm-5.3-flash", 2000, 40));
    const resetCalls: (readonly string[])[] = [];
    const result = recostAllSessions(RATES_BY_MODEL, {
      sessionsRoot: t.root,
      resetOffsetsFn: (files) => {
        resetCalls.push(files);
        return files.length;
      },
    });
    expect(result.files).toBe(2);
    expect(result.lines).toBe(3);
    expect(costTotals(f1).every((c) => c > 0)).toBe(true);
    expect(costTotals(f2).every((c) => c > 0)).toBe(true);
    expect(resetCalls.length).toBe(1);
    expect(resetCalls[0].length).toBe(2);
  });

  test("leaves already-priced lines untouched", () => {
    const t = tempSessions();
    const f = t.add("slug", "s.jsonl", pricedLine(0.5));
    const result = recostAllSessions(RATES_BY_MODEL, { sessionsRoot: t.root, resetOffsetsFn: () => 0 });
    expect(result.files).toBe(0);
    expect(readFileSync(f, "utf8")).toContain("0.5");
  });

  test("resets offsets only for rewritten files", () => {
    const t = tempSessions();
    const priced = t.add("slug", "priced.jsonl", pricedLine(0.5));
    const unpriced = t.add("slug", "unpriced.jsonl", zeroCostLine());
    const resetFiles: (readonly string[])[] = [];
    recostAllSessions(RATES_BY_MODEL, {
      sessionsRoot: t.root,
      resetOffsetsFn: (files) => {
        const collected = [...files];
        resetFiles.push(collected);
        return collected.length;
      },
    });
    expect(resetFiles.length).toBe(1);
    expect(resetFiles[0]).toContain(unpriced);
    expect(resetFiles[0]).not.toContain(priced);
  });

  test("skips models without rates", () => {
    const t = tempSessions();
    const f = t.add("slug", "s.jsonl", zeroCostLine("kimi-k3"));
    const result = recostAllSessions(RATES_BY_MODEL, { sessionsRoot: t.root, resetOffsetsFn: () => 0 });
    expect(result.files).toBe(0);
    expect(costTotals(f).every((c) => c === 0)).toBe(true);
  });
});

describe("createStatsOffsetReset", () => {
  test("deletes offsets only for the given files", () => {
    const dbFile = join(mkdtempSync(join(osTmpdir(), "recost-db-")), "stats.db");
    const db = new Database(dbFile);
    db.run("CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER, last_modified REAL)");
    db.run("INSERT INTO file_offsets VALUES ('/a.jsonl', 1, 1)");
    db.run("INSERT INTO file_offsets VALUES ('/b.jsonl', 2, 2)");
    db.close();
    const reset = createStatsOffsetReset(dbFile);
    expect(reset(["/a.jsonl"])).toBe(1);
    const db2 = new Database(dbFile);
    const left = db2.prepare("SELECT session_file FROM file_offsets").all() as Array<{ session_file: string }>;
    db2.close();
    expect(left.map((r) => r.session_file)).toEqual(["/b.jsonl"]);
  });

  test("missing DB returns 0, never throws", () => {
    expect(createStatsOffsetReset("/nonexistent/stats.db")(["/a.jsonl"])).toBe(0);
  });
});

describe("recost options", () => {
  test("RecostOptions type accepts the documented surface", () => {
    const t = tempSessions();
    const o: RecostOptions = {
      sessionsRoot: t.root,
      readFileFn: readFileSync,
      writeFileFn: writeFileSync,
      resetOffsetsFn: () => 0,
    };
    expect(recostAllSessions(RATES_BY_MODEL, o).files).toBe(0);
  });
});

void (undefined as unknown as RecostOptions | undefined);