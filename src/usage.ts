// Ollama Cloud usage fetcher for omp's /usage, status-line footer, usage
// history, and credential health probe. omp's built-in ollama-cloud
// UsageProvider reports "no standalone quota usage API" (pi-ai
// usage/ollama.ts); ollama.com actually serves one at GET /api/usage, so the
// plugin registers this fetcher through registerProvider({ usage }) and
// AuthStorage.setRuntimeUsageProvider replaces the built-in stub for the
// session's lifetime.
//
// Security posture: the endpoint is fixed to the ollama.com origin, the
// credential only ever travels in the Authorization header to that origin,
// and the response is parsed through a hand-rolled type guard (same style as
// isCatalog) that validates every consumed field. Nothing from the response
// is executed, rendered as markup, or written to disk; numbers feed the
// normalized UsageLimit shape and strings become plain labels.
//
// Never throws: any malformed response, network failure, or unexpected shape
// resolves to null and omp's cache/fan-out treats it like every other failed
// provider probe (short cool-down, last-good retention).

import type {
  UsageFetchContext,
  UsageFetchParams,
  UsageProvider,
  UsageReport,
} from "@oh-my-pi/pi-ai";

export const USAGE_URL = "https://ollama.com/api/usage";
/** Per-request timeout, mirroring the catalog loader's 5 s budget. */
export const USAGE_TIMEOUT_MS = 5000;

/** One limit entry normalized from the endpoint's `limits` block. */
export interface OllamaWindowUsage {
  /** Raw key ("session", "weekly") — becomes the limit/window id. */
  key: string;
  /** Fraction used (0..1) as reported by the endpoint. */
  usage: number;
  /** Per-model request counts, in upstream order. */
  models: { name: string; requestCount: number }[];
}

export interface OllamaUsagePayload {
  /** Activity block: 4-week rolling spend. Zero cost → no activity limit. */
  activity: {
    /** Cost in USD (arrives string-encoded upstream, "0.00000"). */
    cost: number;
    periodStart: string | undefined;
    periodEnd: string | undefined;
  };
  limits: OllamaWindowUsage[];
}

/** The isCatalog helpers stay in catalog.ts; the shapes are private there. */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** Finite number in [0, 1] — the fraction shape every limit usage carries. */
const isFraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Non-negative finite number — request counts and the activity cost. */
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** "0.00000" → 0. Non-numeric input → NaN so the count guard rejects it. */
function parseDecimal(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Loader-side shape check of GET /api/usage. Mirrors the observed wire shape
 * on the fields the fetcher CONSUMES; unknown fields pass unchecked (the
 * endpoint may grow — the loader only guards its own reads, same contract as
 * isCatalog upstream).
 */
export function isOllamaUsagePayload(value: unknown): value is OllamaUsagePayload {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Record<string, unknown>;

  const activity = doc.activity as Record<string, unknown> | undefined;
  if (!activity || typeof activity !== "object") return false;
  if (!isCount(parseDecimal(activity.cost))) return false;
  const period = activity.period as Record<string, unknown> | undefined;
  if (
    period !== undefined &&
    (typeof period !== "object" ||
      period === null ||
      !isNonEmptyString(period.starting_at) ||
      !isNonEmptyString(period.ending_at))
  )
    return false;

  const limits = doc.limits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) return false;
  return Object.entries(limits as Record<string, unknown>).every(([key, raw]) => {
    if (!isNonEmptyString(key)) return false;
    if (raw === null || raw === undefined) return true; // window absent → skipped
    if (typeof raw !== "object") return false;
    const window = raw as Record<string, unknown>;
    if (!isFraction(window.usage)) return false;
    if (window.models === undefined) return true;
    if (!Array.isArray(window.models)) return false;
    return window.models.every((m) => {
      if (typeof m !== "object" || m === null) return false;
      const model = m as Record<string, unknown>;
      return isNonEmptyString(model.name) && isCount(model.request_count);
    });
  });
}

/** Validated wire shape → the plugin's view. Exported as the test seam. */
export function toOllamaUsagePayload(value: unknown): OllamaUsagePayload {
  const doc = value as Record<string, unknown>;
  const activity = doc.activity as Record<string, unknown>;
  const period = activity.period as Record<string, unknown> | undefined;
  const limitsRaw = doc.limits as Record<string, unknown>;
  const limits: OllamaWindowUsage[] = [];
  for (const [key, raw] of Object.entries(limitsRaw)) {
    if (raw === null || raw === undefined || typeof raw !== "object") continue;
    const window = raw as Record<string, unknown>;
    if (!isFraction(window.usage)) continue;
    const models = Array.isArray(window.models)
      ? window.models.flatMap((m) => {
          if (typeof m !== "object" || m === null) return [];
          const model = m as Record<string, unknown>;
          if (!isNonEmptyString(model.name) || !isCount(model.request_count)) return [];
          return [{ name: model.name, requestCount: model.request_count }];
        })
      : [];
    limits.push({ key, usage: window.usage, models });
  }
  return {
    activity: {
      cost: parseDecimal(activity.cost),
      periodStart:
        period && isNonEmptyString(period.starting_at) ? period.starting_at : undefined,
      periodEnd: period && isNonEmptyString(period.ending_at) ? period.ending_at : undefined,
    },
    limits,
  };
}

const WINDOW_LABELS: Record<string, string> = {
  session: "Session",
  weekly: "Weekly",
  daily: "Daily",
  monthly: "Monthly",
};

// The session bucket is Ollama's short rolling window (a few hours); weekly
// and longer keys get their exact durations. Unknown keys stay durationless —
// omp renders them as label-only rows instead of guessing a window length.
const WINDOW_MS: Record<string, number> = {
  session: 5 * 3_600_000,
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
};

/** Up to three per-model notes, "name (N requests)". */
export function limitNotes(limit: OllamaWindowUsage, max = 3): string[] {
  return limit.models
    .slice(0, max)
    .map((m) => `${m.name} (${m.requestCount} request${m.requestCount === 1 ? "" : "s"})`);
}

/**
 * Wire payload → omp's normalized UsageReport. Exported as the test seam.
 *
 * Each window becomes one UsageLimit with unit "percent" and usedFraction,
 * which omp's renderers turn into the bar + "% used" line and the status
 * colors (ok < 0.8, warning ≥ 0.8, exhausted ≥ 1). The activity cost is
 * surfaced as a second limit (unit "usd", 4-week window) only when nonzero,
 * so idle accounts show the two quota rows without a $0.00 filler.
 */
export function toUsageReport(
  payload: OllamaUsagePayload,
  provider: string,
  fetchedAt: number,
): UsageReport {
  const limits: UsageReport["limits"] = payload.limits.map((limit) => {
    const id = limit.key.toLowerCase();
    const label = windowLabel(limit.key);
    const durationMs = WINDOW_MS[id];
    return {
      id,
      label,
      scope: { provider, shared: true },
      window: {
        id,
        label,
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
      amount: { unit: "percent", usedFraction: limit.usage },
      status: limit.usage >= 1 ? "exhausted" : limit.usage >= 0.8 ? "warning" : "ok",
      notes: limitNotes(limit),
    };
  });
  if (payload.activity.cost > 0) {
    const startMs = isoToMs(payload.activity.periodStart);
    const endMs = isoToMs(payload.activity.periodEnd);
    const durationMs =
      startMs !== undefined && endMs !== undefined && endMs > startMs
        ? endMs - startMs
        : undefined;
    limits.push({
      id: "activity",
      label: "Activity cost (4 weeks)",
      scope: { provider, shared: true },
      ...(durationMs !== undefined
        ? { window: { id: "activity", label: "4 weeks", durationMs } }
        : {}),
      amount: { unit: "usd", used: payload.activity.cost },
      status: "ok",
      notes: ["USD spent in the trailing four-week window"],
    });
  }
  return {
    provider,
    fetchedAt,
    limits,
    notes: ["Quota fractions as reported by ollama.com /api/usage."],
  };
}

const isoToMs = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
};

/** Human label for a window key; unknown keys render as-is. */
function windowLabel(key: string): string {
  return WINDOW_LABELS[key.toLowerCase()] ?? key;
}

/**
 * The UsageProvider handed to pi.registerProvider({ usage }). Reads the
 * credential from params (omp resolves stored login keys and the
 * OLLAMA_CLOUD_API_KEY env var) and contacts ONE fixed origin.
 *
 * Credential-egress hardening: the fetch target is pinned to USAGE_URL
 * (https + ollama.com + exact path); params.baseUrl is ignored so a redirected
 * provider config can never move the credential off ollama.com, and the URL is
 * re-verified immediately before the call to defeat any later reassignment of
 * the module constant. The key exists only inside this function's scope: it is
 * placed in the Authorization header, never logged, never persisted, and never
 * forwarded to any other host. fetchFn remains an injectable test seam; ctx.fetch
 * (omp's own fetch, which honors proxy/TLS settings) takes precedence in production.
 * Null on any failure — never throws, per the plugin's host contract.
 */
export function createOllamaCloudUsageProvider(
  providerId: string,
  fetchFn: typeof fetch = fetch,
): UsageProvider {
  return {
    id: providerId,
    validatesCredentials: true,
    retainLastGoodOnFailure: true,
    async fetchUsage(
      params: UsageFetchParams,
      ctx: UsageFetchContext,
    ): Promise<UsageReport | null> {
      const apiKey = params.credential.apiKey?.trim() || params.credential.accessToken?.trim();
      if (!apiKey) return null;
      const doFetch = ctx.fetch ?? fetchFn;
      try {
        const url = new URL(USAGE_URL);
        if (url.protocol !== "https:" || url.hostname !== "ollama.com") return null;
        const res = await doFetch(url, {
          signal: params.signal ?? AbortSignal.timeout(USAGE_TIMEOUT_MS),
          headers: { accept: "application/json", Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) return null;
        const parsed: unknown = await res.json();
        if (!isOllamaUsagePayload(parsed)) return null;
        return toUsageReport(toOllamaUsagePayload(parsed), providerId, Date.now());
      } catch {
        return null;
      }
    },
  };
}