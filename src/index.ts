// oh-my-pi extension: Ollama Cloud provider with the official rate card from
// the srnoob2570/ollama-cloud-catalog artifact, plus a live streaming-stats
// widget. Ported from @srnoob2570/opencode-ollama-cloud; /model is
// deliberately not ported (omp ships its own /model), and the /stats dialog
// was scoped out (omp ships a /stats dashboard).

import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import { loadCatalog, PROVIDER_ID, type CatalogModel } from "./catalog.ts";
import { toProviderModel } from "./models.ts";
import { summarize, type StepMeasurement } from "./stats.ts";
import { runSelfUpdate } from "./self-update.ts";
import { formatLiveLine } from "./widget.ts";

const WIDGET_KEY = "ollama-cloud-stats";
const MAX_COLLECTOR_STEPS = 500;
const PACKAGE_SPEC = "@srnoob2570/omp-ollama-cloud";

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
    if (message.provider !== PROVIDER_ID) return;
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
    if (steps.length > MAX_COLLECTOR_STEPS) steps.shift();
    if (uiCtx) renderWidget(ctx);
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

export default function ollamaCloudOmp(pi: ExtensionAPI): void {
  pi.setLabel("Ollama Cloud");
  const pricing = knob("OMP_OLLAMA_CLOUD_PRICING", true) ? "on" : "off";
  pi.registerProvider(PROVIDER_ID, {
    // Model-level baseUrl comes from the bundled per-id defaults; the
    // provider-level baseUrl is still required non-undefined by the
    // model builder, so set the ollama.com origin.
    baseUrl: "https://ollama.com",
    api: "ollama-chat",
    fetchDynamicModels: async () => fetchCatalogModels(pricing),
  });

  if (knob("OMP_OLLAMA_CLOUD_STATS", true)) installStats(pi);

  // Boot-time self-update probe, fire-and-forget, never throws.
  const moduleUrl = import.meta.url;
  void runSelfUpdate({ moduleUrl }).then((result) => {
    if (result.outcome === "update-available" && result.latest) {
      updateVersion = result.latest;
      if (renderWidgetLive && uiCtxRef) renderWidgetLive(uiCtxRef);
    }
  });
}