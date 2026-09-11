// oh-my-pi extension: Ollama Cloud provider with the official rate card from
// the srnoob2570/ollama-cloud-catalog artifact, plus a live streaming-stats
// widget and a real quota-usage fetcher for omp's /usage surfaces. Ported
// from @srnoob2570/opencode-ollama-cloud; /model is deliberately not ported
// (omp ships its own /model), and the /stats dialog was scoped out (omp ships
// a /stats dashboard). Also works around the omp ollama-chat adapter bug
// that persists usage.cost = $0 (see cost-fix.ts).

import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import { loadCatalog, PROVIDER_ID, type CatalogModel } from "./catalog.ts";
import { createOllamaCloudUsageProvider } from "./usage.ts";
import { toProviderModel } from "./models.ts";
import { summarize, type StepMeasurement } from "./stats.ts";
import { runSelfUpdate } from "./self-update.ts";
import { formatLiveLine } from "./widget.ts";
import { fixSessionFileCosts, type CostRates } from "./cost-fix.ts";
import { recostAllSessions, createStatsOffsetReset } from "./recost.ts";

const WIDGET_KEY = "ollama-cloud-stats";
const MAX_COLLECTOR_STEPS = 500;
const PACKAGE_SPEC = "@srnoob2570/omp-ollama-cloud";

// Set at factory time: cost patching requires both the workaround knob and
// official pricing on (with pricing off the patched value would be $0 anyway).
// usageEnabled gates the /api/usage fetcher registration below.
let costFixEnabled = false;
let pricingOn = true;
let usageEnabled = true;

/** Knobs: omp does not pass options to extension factories, so env vars. */
function knob(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

// Module-level session state: one stats instance per main-session process
// (task subagents run in their own runners without extensions, so no
// concurrent writers). The self-update probe writes the badge version and
// re-renders through the hook installed by installStats.
let steps: StepMeasurement[] = [];
let updateVersion: string | null = null;
let renderWidgetLive: ((ctx: ExtensionContext) => void) | undefined;
const costRatesByModel = new Map<string, CostRates>();
const resetStatsOffset = createStatsOffsetReset();
let uiCtxRef: ExtensionContext | undefined;

const widgetLines = (): string[] => {
  const lines = [formatLiveLine(summarize(steps))];
  if (updateVersion)
    lines.push(
      `↑ ${updateVersion} available — omp plugin install ${PACKAGE_SPEC}`,
    );
  return lines;
};

const renderWidget = (ctx: ExtensionContext): void => {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, widgetLines(), {
    placement: "belowEditor",
  });
};

function installStats(pi: ExtensionAPI): void {
  let uiCtx: ExtensionContext | undefined;
  // omp fires session_start on boot, but session switches (/new, resume,
  // fork) and branches arrive as separate events; the stats window is
  // per-session, so reset the collector and re-capture the UI context.
  const attach = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    uiCtx = ctx;
    uiCtxRef = ctx;
    renderWidget(ctx);
  };
  const reset = (ctx: ExtensionContext): void => {
    steps = [];
    attach(ctx);
  };
  pi.on("session_start", (_event, ctx) => attach(ctx));
  pi.on("session_switch", (_event, ctx) => reset(ctx));
  pi.on("session_branch", (_event, ctx) => reset(ctx));
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (typeof message.duration !== "number") return;
    if (!(message.usage.output > 0)) return;
    const ttft = typeof message.ttft === "number" ? message.ttft : 0;
    steps.push({
      modelID: message.model,
      ttftMs: Math.max(0, ttft),
      tokensOut: message.usage.output,
      durationMs: Math.max(0, message.duration),
      ts: message.timestamp,
    });
    if (costFixEnabled && pricingOn) {
      // omp's ollama-chat adapter never prices usage (upstream bug), so the
      // session line lands with cost = $0 and every cost consumer (status
      // line, /usage, omp-stats) shows $0. omp defers the session-file write
      // to the turn flush, so collect rate cards here and re-price the whole
      // file at agent_end. Scoped to ollama-cloud: other providers are
      // priced by omp itself.
      if (message.provider === PROVIDER_ID) {
        const model = ctx.model;
        if (model && model.id === message.model && !costRatesByModel.has(model.id)) {
          costRatesByModel.set(model.id, model.cost);
        }
      }
    }
    if (uiCtx) renderWidget(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (!costFixEnabled || !pricingOn || costRatesByModel.size === 0) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const outcome = fixSessionFileCosts(sessionFile, costRatesByModel);
    if (outcome === "patched") {
      costRatesByModel.clear();
      // The patch rewrites the file in place and changes byte lengths, so
      // omp-stats' stored offset no longer points at a line boundary — reset
      // it so the dashboard's next sync re-parses the whole file.
      resetStatsOffset([sessionFile ?? ""].filter(Boolean));
    }
  });
  pi.on("session_shutdown", () => {
    if (uiCtx?.mode === "tui" && uiCtx.hasUI)
      uiCtx.ui.setWidget(WIDGET_KEY, undefined);
    steps = [];
    uiCtx = undefined;
    uiCtxRef = undefined;
  });
  renderWidgetLive = (ctx) => renderWidget(ctx);
}

async function fetchCatalogModels(
  pricing: "off" | "on",
): Promise<readonly ProviderModelConfig[]> {
  const catalog = await loadCatalog();
  if (!catalog) return [];
  return catalog.models.map((m: CatalogModel) => toProviderModel(m, pricing));
}

/** Model id → rate card, from the catalog (official rates; empty on failure). */
async function catalogRates(): Promise<Map<string, CostRates>> {
  const rates = new Map<string, CostRates>();
  try {
    const catalog = await loadCatalog();
    if (!catalog) return rates;
    for (const m of catalog.models) {
      if (!m.cost) continue;
      rates.set(m.id, {
        input: m.cost.input,
        output: m.cost.output,
        cacheRead: m.cost.cachedInput ?? 0,
        cacheWrite: 0,
      });
    }
  } catch {
    // catalog optional: empty map → command reports nothing to re-price
  }
  return rates;
}

export default function ollamaCloudOmp(pi: ExtensionAPI): void {
  pi.setLabel("Ollama Cloud");
  pricingOn = knob("OMP_OLLAMA_CLOUD_PRICING", true);
  costFixEnabled = knob("OMP_OLLAMA_CLOUD_COST_FIX", true);
  usageEnabled = knob("OMP_OLLAMA_CLOUD_USAGE", true);
  const pricing = pricingOn ? "on" : "off";
  // OMP_OLLAMA_CLOUD_BASE_URL points the provider at a local proxy (e.g. the
  // ollama-cloud-meter reverse proxy). Model-level baseUrl comes from the
  // bundled per-id defaults; the provider-level baseUrl must stay
  // non-undefined for the model builder, so keep the ollama.com origin as the
  // default. omp loads ~/.omp/agent/.env eagerly, so a line there is enough.
  const baseUrl =
    process.env.OMP_OLLAMA_CLOUD_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://ollama.com";
  pi.registerProvider(PROVIDER_ID, {
    baseUrl,
    api: "ollama-chat",
    fetchDynamicModels: async () => fetchCatalogModels(pricing),
    // Replaces omp's built-in "no standalone quota usage API" ollama-cloud
    // stub with the real GET https://ollama.com/api/usage fetcher. omp wires
    // it through AuthStorage.setRuntimeUsageProvider for the session's
    // lifetime, which feeds /usage, the status-line footer, usage history,
    // and credential health probes. The stub stays active for surfaces that
    // don't load extensions (the standalone `omp usage` CLI command).
    ...(usageEnabled ? { usage: createOllamaCloudUsageProvider(PROVIDER_ID) } : {}),
  });

  if (knob("OMP_OLLAMA_CLOUD_STATS", true)) installStats(pi);

  pi.registerCommand("ollama-recost", {
    description:
      "Re-price the $0 ollama-cloud lines of every saved session (omp adapter bug workaround)",
    handler: async (_args, ctx) => {
      const rates = await catalogRates();
      if (rates.size === 0) {
        ctx.ui.notify("ollama-recost: catalog unavailable — nothing to re-price", "warning");
        return;
      }
      const result = recostAllSessions(rates);
      ctx.ui.notify(
        result.files > 0
          ? `ollama-recost: ${result.files} session file(s) rewritten, ${result.lines} request(s) re-priced. Run the omp-stats sync to refresh the dashboard.`
          : "ollama-recost: no unpriced ollama-cloud lines found",
        "info",
      );
    },
  });

  // Boot-time self-update probe, fire-and-forget, never throws.
  const moduleUrl = import.meta.url;
  void runSelfUpdate({ moduleUrl }).then((result) => {
    if (result.outcome === "update-available" && result.latest) {
      updateVersion = result.latest;
      if (renderWidgetLive && uiCtxRef) renderWidgetLive(uiCtxRef);
    }
  });
}