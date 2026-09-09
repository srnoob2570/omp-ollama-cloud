import { describe, expect, test } from "bun:test";
import {
  USAGE_URL,
  createOllamaCloudUsageProvider,
  isOllamaUsagePayload,
  limitNotes,
  toOllamaUsagePayload,
  toUsageReport,
} from "./usage.ts";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai";

// Fixture mirrors the live GET /api/usage shape observed from ollama.com
// (cost string-encoded; per-model request counts under each window).
const samplePayload = () => ({
  activity: {
    cost: "0.00000",
    period: {
      type: "last_4_weeks",
      starting_at: "2026-08-17T00:00:00Z",
      ending_at: "2026-09-09T14:37:12.911703696Z",
    },
    models: [],
  },
  limits: {
    session: {
      usage: 0.213,
      models: [{ name: "glm-5.3-flash", request_count: 1033 }],
    },
    weekly: {
      usage: 0.318,
      models: [
        { name: "glm-5.3-flash", request_count: 8594 },
        { name: "kimi-k3", request_count: 51 },
      ],
    },
  },
});

describe("isOllamaUsagePayload", () => {
  test("accepts the observed wire shape", () => {
    expect(isOllamaUsagePayload(samplePayload())).toBe(true);
  });

  test("accepts a window with no models array", () => {
    expect(isOllamaUsagePayload({ activity: { cost: "1" }, limits: { daily: { usage: 0.5 } } })).toBe(
      true,
    );
  });

  test("accepts null/undefined window entries (skipped downstream)", () => {
    expect(isOllamaUsagePayload({ activity: { cost: "1" }, limits: { peak: null } })).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(isOllamaUsagePayload(null)).toBe(false);
    expect(isOllamaUsagePayload("x")).toBe(false);
    expect(isOllamaUsagePayload([])).toBe(false);
  });

  test("rejects a missing or malformed activity block", () => {
    expect(isOllamaUsagePayload({ limits: {} })).toBe(false);
    expect(isOllamaUsagePayload({ activity: { cost: "free" }, limits: {} })).toBe(false);
    expect(isOllamaUsagePayload({ activity: { cost: "-1" }, limits: {} })).toBe(false);
  });

  test("rejects a malformed period", () => {
    expect(
      isOllamaUsagePayload({
        activity: { cost: "1", period: { starting_at: "" } },
        limits: {},
      }),
    ).toBe(false);
  });

  test("rejects non-object limits or bad window entries", () => {
    expect(isOllamaUsagePayload({ activity: { cost: "1" }, limits: [] })).toBe(false);
    expect(
      isOllamaUsagePayload({ activity: { cost: "1" }, limits: { session: { usage: 2 } } }),
    ).toBe(false);
    expect(
      isOllamaUsagePayload({ activity: { cost: "1" }, limits: { session: { usage: "x" } } }),
    ).toBe(false);
    expect(
      isOllamaUsagePayload({
        activity: { cost: "1" },
        limits: { session: { usage: 0.5, models: [{ name: "m", request_count: -1 }] } },
      }),
    ).toBe(false);
  });
});

describe("toOllamaUsagePayload", () => {
  test("parses cost, period, and per-window models", () => {
    const payload = toOllamaUsagePayload(samplePayload());
    expect(payload.activity.cost).toBe(0);
    expect(payload.activity.periodStart).toBe("2026-08-17T00:00:00Z");
    expect(payload.limits).toHaveLength(2);
    expect(payload.limits[0]).toEqual({
      key: "session",
      usage: 0.213,
      models: [{ name: "glm-5.3-flash", requestCount: 1033 }],
    });
  });

  test("skips null windows and drops malformed model rows", () => {
    const payload = toOllamaUsagePayload({
      activity: { cost: "2.5" },
      limits: {
        peak: null,
        weekly: {
          usage: 0.1,
          models: [{ name: "good", request_count: 3 }, { request_count: 4 }, "junk"],
        },
      },
    });
    expect(payload.limits).toEqual([
      {
        key: "weekly",
        usage: 0.1,
        models: [{ name: "good", requestCount: 3 }],
      },
    ]);
    expect(payload.activity.cost).toBe(2.5);
    expect(payload.activity.periodStart).toBeUndefined();
  });
});

describe("toUsageReport", () => {
  test("maps windows to percent limits with status thresholds", () => {
    const report = toUsageReport(
      toOllamaUsagePayload(samplePayload()),
      "ollama-cloud",
      1234,
    );
    expect(report.provider).toBe("ollama-cloud");
    expect(report.fetchedAt).toBe(1234);
    expect(report.limits).toHaveLength(2);

    const session = report.limits[0];
    expect(session.id).toBe("session");
    expect(session.label).toBe("Session");
    expect(session.scope).toEqual({ provider: "ollama-cloud", shared: true });
    expect(session.amount).toEqual({ unit: "percent", usedFraction: 0.213 });
    expect(session.status).toBe("ok");
    expect(session.window).toEqual({
      id: "session",
      label: "Session",
      durationMs: 5 * 3_600_000,
    });
    expect(session.notes).toEqual(["glm-5.3-flash (1033 requests)"]);

    const weekly = report.limits[1];
    expect(weekly.status).toBe("ok");
    expect(weekly.window?.durationMs).toBe(7 * 86_400_000);
    expect(weekly.notes).toHaveLength(2);
  });

  test("status escalates at 0.8 and 1.0", () => {
    const payload = toOllamaUsagePayload({
      activity: { cost: "0" },
      limits: { a: { usage: 0.79 }, b: { usage: 0.8 }, c: { usage: 1 } },
    });
    const report = toUsageReport(payload, "ollama-cloud", 0);
    expect(report.limits.map((l) => l.status)).toEqual(["ok", "warning", "exhausted"]);
  });

  test("unknown window keys render as-is without a duration", () => {
    const report = toUsageReport(
      toOllamaUsagePayload({ activity: { cost: "0" }, limits: { peak_hours: { usage: 0.5 } } }),
      "ollama-cloud",
      0,
    );
    expect(report.limits[0].label).toBe("peak_hours");
    expect(report.limits[0].window?.durationMs).toBeUndefined();
  });

  test("nonzero activity cost becomes a usd limit with the 4-week window", () => {
    const report = toUsageReport(
      toOllamaUsagePayload({
        activity: {
          cost: "1.25",
          period: {
            starting_at: "2026-08-17T00:00:00Z",
            ending_at: "2026-09-09T00:00:00Z",
          },
        },
        limits: {},
      }),
      "ollama-cloud",
      0,
    );
    expect(report.limits).toHaveLength(1);
    const activity = report.limits[0];
    expect(activity.amount).toEqual({ unit: "usd", used: 1.25 });
    expect(activity.window?.durationMs).toBe(23 * 86_400_000);
  });

  test("zero activity cost adds no limit row", () => {
    const report = toUsageReport(
      toOllamaUsagePayload({ activity: { cost: "0.00000" }, limits: {} }),
      "ollama-cloud",
      0,
    );
    expect(report.limits).toHaveLength(0);
  });

  test("unparseable period yields no window duration", () => {
    const report = toUsageReport(
      toOllamaUsagePayload({
        activity: { cost: "3", period: { starting_at: "x", ending_at: "y" } },
        limits: {},
      }),
      "ollama-cloud",
      0,
    );
    expect(report.limits[0].window).toBeUndefined();
  });
});

describe("limitNotes", () => {
  test("caps at three models with singular/plural counts", () => {
    const notes = limitNotes({
      key: "weekly",
      usage: 0.5,
      models: [
        { name: "a", requestCount: 1 },
        { name: "b", requestCount: 2 },
        { name: "c", requestCount: 3 },
        { name: "d", requestCount: 4 },
      ],
    });
    expect(notes).toEqual(["a (1 request)", "b (2 requests)", "c (3 requests)"]);
  });
});

describe("createOllamaCloudUsageProvider", () => {
  // The FetchImpl type carries a real fetch's preconnect property; a stub
  // only needs the call shape the provider exercises.
  type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  const fetchStub = (fn: FetchStub): typeof fetch => {
    const base = async (input: string | URL | Request, init?: RequestInit) => fn(input, init);
    return base as unknown as typeof fetch;
  };
  const makeParams = (apiKey?: string) => ({
    provider: "ollama-cloud",
    credential: { type: "api_key", ...(apiKey ? { apiKey } : {}) },
  }) as UsageFetchParams;

  test("returns null without a credential and never fetches", async () => {
    let called = 0;
    const provider = createOllamaCloudUsageProvider(
      "ollama-cloud",
      fetchStub(async () => {
        called += 1;
        throw new Error("should not fetch");
      }),
    );
    const report = await provider.fetchUsage(makeParams(), { fetch: undefined as never });
    expect(report).toBeNull();
    expect(called).toBe(0);
  });

  test("pins egress to the https ollama.com origin with a Bearer header", async () => {
    let seenUrl: URL | undefined;
    let seenAuth = "";
    const provider = createOllamaCloudUsageProvider(
      "ollama-cloud",
      fetchStub(async (input, init) => {
        seenUrl = input instanceof URL ? input : new URL(String(input));
        seenAuth = String(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify(samplePayload()), { status: 200 });
      }),
    );
    const report = await provider.fetchUsage(makeParams(" key-123 "), { fetch: undefined as never });
    expect(seenUrl?.protocol).toBe("https:");
    expect(seenUrl?.hostname).toBe("ollama.com");
    expect(seenUrl?.pathname).toBe("/api/usage");
    expect(seenAuth).toBe("Bearer key-123");
    expect(report?.provider).toBe("ollama-cloud");
    expect(report?.limits.map((l) => l.id)).toEqual(["session", "weekly"]);
  });

  test("returns null on HTTP errors and malformed bodies", async () => {
    for (const make of [
      async () => new Response("nope", { status: 401 }),
      async () => new Response("<html>", { status: 200 }),
      async () => new Response('{"limits":"x"}', { status: 200 }),
    ]) {
      const provider = createOllamaCloudUsageProvider(
        "ollama-cloud",
        fetchStub(async () => await make()),
      );
      expect(await provider.fetchUsage(makeParams("k"), { fetch: undefined as never })).toBeNull();
    }
  });

  test("falls back to the access token for oauth-style credentials", async () => {
    let seenAuth = "";
    const provider = createOllamaCloudUsageProvider(
      "ollama-cloud",
      fetchStub(async (_input, init) => {
        seenAuth = String(new Headers(init?.headers).get("Authorization"));
        return new Response(JSON.stringify({ activity: { cost: "0" }, limits: {} }), {
          status: 200,
        });
      }),
    );
    const report = await provider.fetchUsage(
      {
        provider: "ollama-cloud",
        credential: { type: "oauth", accessToken: "tok-1" },
      } as UsageFetchParams,
      { fetch: undefined as never },
    );
    expect(seenAuth).toBe("Bearer tok-1");
    expect(report?.limits).toHaveLength(0);
  });
});