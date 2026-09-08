// Self-update check for npm installs. Adapted from
// opencode-ollama-cloud/plugin/self-update.ts: omp has no documented
// eviction plumbing, so this variant only PROBES the registry and reports —
// the user reinstalls with `omp plugin install`. Eviction, pinned-version
// suffix parsing, update.json records and the toast client are dropped;
// compareSemver and the dev-checkout opt-out survive. Never throws.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@srnoob2570/omp-ollama-cloud";
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export type ModuleOrigin =
  | { source: "npm"; pluginsRoot: string }
  | { source: "dev" };

/**
 * Where is this module running from? omp installs plugins under
 * ~/.omp/plugins/node_modules/<pkg>/…; anything else (a repo checkout,
 * `omp plugin link`, a foreign path) is "dev" and opts out. `null` means the
 * path is unusable for self-update decisions.
 */
export function parseModuleOrigin(
  moduleUrl: string,
  pluginsRoot: string = join(
    (typeof process !== "undefined" && process.env.HOME) || "",
    ".omp",
    "plugins",
  ),
): ModuleOrigin | null {
  const path = moduleUrl.startsWith("file://")
    ? fileURLToPath(moduleUrl)
    : moduleUrl;
  if (path.length === 0) return null;
  if (!path.startsWith(join(pluginsRoot, "node_modules")))
    return { source: "dev" };
  return { source: "npm", pluginsRoot };
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 1 if a > b, -1 if a < b, 0 if equal, null if either is not a version. */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++)
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

/**
 * Walk up from a module file to the nearest package.json that is ours and
 * return its version (the findPackageDir pattern; works in dev too, where
 * the caller is gated off before acting on it).
 */
export async function findInstalledVersion(
  moduleUrl: string,
  readFileFn: typeof readFile = readFile,
): Promise<string | null> {
  let path = moduleUrl.startsWith("file://")
    ? fileURLToPath(moduleUrl)
    : moduleUrl;
  for (let depth = 0; depth < 40; depth++) {
    const dir = dirname(path);
    try {
      const pkg = JSON.parse(
        await readFileFn(join(dir, "package.json"), "utf8"),
      );
      if (pkg?.name === PACKAGE_NAME)
        return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      /* not ours / missing — keep walking */
    }
    if (dir === dirname(dir)) return null;
    path = dir;
  }
  return null;
}

/** One registry probe per boot; any failure is silent (best-effort). */
export async function fetchLatestVersion(
  timeoutMs = 10_000,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(REGISTRY_LATEST_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

export type UpdateDecision =
  | { action: "update"; latest: string }
  | { action: "none" };

export function decideUpdate(input: {
  installed: string | null;
  latest: string | null;
  isNpm: boolean;
}): UpdateDecision {
  if (!input.isNpm || !input.installed || !input.latest)
    return { action: "none" };
  const cmp = compareSemver(input.latest, input.installed);
  return cmp !== null && cmp > 0
    ? { action: "update", latest: input.latest }
    : { action: "none" };
}

export type SelfUpdateOutcome =
  | "update-available"
  | "current"
  | "skipped-dev"
  | "skipped-unknown-root"
  | "skipped-no-version"
  | "failed";

/**
 * Boot-time probe: detect origin → read installed version → probe the
 * registry → decide. On "update" the caller gets the latest version to
 * surface (widget line + notify); omp itself has no eviction API, so the
 * plugin never mutates its own install. Never throws.
 */
export async function runSelfUpdate(args: {
  moduleUrl: string;
  pluginsRoot?: string;
}): Promise<{ outcome: SelfUpdateOutcome; latest?: string }> {
  try {
    const origin = parseModuleOrigin(args.moduleUrl, args.pluginsRoot);
    if (origin === null) return { outcome: "skipped-unknown-root" };
    if (origin.source === "dev") return { outcome: "skipped-dev" };
    const installed = await findInstalledVersion(args.moduleUrl);
    if (!installed) return { outcome: "skipped-no-version" };
    const latest = await fetchLatestVersion();
    const decision = decideUpdate({ installed, latest, isNpm: true });
    if (decision.action === "update")
      return { outcome: "update-available", latest: decision.latest };
    return { outcome: "current" };
  } catch {
    return { outcome: "failed" as SelfUpdateOutcome };
  }
}