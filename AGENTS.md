# Repository Guidelines

oh-my-pi plugin registering an **Ollama Cloud provider** for omp: model catalog + official USD pricing from the `srnoob2570/ollama-cloud-catalog` artifact, a live streaming-stats widget, a real quota-usage fetcher for omp's `/usage` surfaces, a workaround for omp's $0-cost `ollama-chat` adapter bug, and an npm self-update probe. Runs inside the Bun-based omp runtime — not standalone.

## Architecture & Data Flow

```text
catalog artifact (2 CDN mirrors, mirror-race, 5s timeout)
  → catalog.ts  fetch + validate + disk cache (~/.cache/omp-ollama-cloud/catalog.json)
  → models.ts   toProviderModel: CatalogModel → omp ProviderModelConfig
  → index.ts    pi.registerProvider("ollama-cloud", { fetchDynamicModels, usage })
  → usage.ts    createOllamaCloudUsageProvider: GET ollama.com/api/usage →
                normalized UsageReport (session/weekly percent limits, USD activity)

Runtime (per session, module-level state in index.ts):
  message_end → stats.ts StepMeasurement → widget.ts "X tok/s · TTFT Y ms" → TUI widget
  agent_end   → cost-fix.ts re-price $0 session lines → reset omp-stats file_offsets
  boot        → self-update.ts npm probe (report-only) → widget badge line

Manual: /ollama-recost → recost.ts batch re-price all ~/.omp/agent/sessions/*.jsonl
Usage: /usage (session) + status-line footer + usage history ← omp AuthStorage
       runtime usage provider registered by index.ts (fetchUsage in usage.ts)
```

- `src/index.ts` — entry: default-exported extension factory. Registers provider (`setLabel`, `registerProvider`, `registerCommand("ollama-recost")`), hooks `session_start`/`session_switch`/`session_branch`/`message_end`/`agent_end`/`session_shutdown`. Holds all module-level session state (`steps`, `costRatesByModel`, widget render callback); task subagents run in separate runners without extensions, so single-writer is safe.
- `src/catalog.ts` — `loadCatalog()`: hand-rolled Promise race across jsDelivr + raw.githubusercontent mirrors; `isCatalog` type guard validates only consumed fields (extra artifact fields pass unchecked); cache written/read only if it validates; all disk errors swallowed.
- `src/models.ts` — single export `toProviderModel(m, pricing)`: cost block `{ input, output, cacheRead: cachedInput, cacheWrite: 0 }`, thinking efforts filtered against `@oh-my-pi/pi-catalog/effort` `Effort`, modalities text/image only.
- `src/stats.ts` / `src/widget.ts` — pure cores. TPS = total output tokens / total stream duration (deliberately includes TTFT/prompt time; Ollama Cloud buffers output in bursts, decode-only math reports 500+ tok/s). TTFT = simple mean. No wire interception; reads omp's own `AssistantMessage.duration`/`ttft`.
- `src/cost-fix.ts` — patches `usage.cost` in the session `.jsonl` at `agent_end` (omp hands extensions only a cloned snapshot at `message_end`; file write defers to turn flush). Only touches lines with cost exactly 0; no-op once the upstream adapter bug is fixed. Rates are USD per 1M tokens (`priceUsage`).
- `src/recost.ts` — batch variant for `/ollama-recost`; resets `file_offsets` in `~/.omp/stats.db` (only `bun:sqlite` usage) for **every** session file, not just patched ones (stale dashboard offsets; re-parse is idempotent). Never runs on boot.
- `src/usage.ts` — `createOllamaCloudUsageProvider(PROVIDER_ID)`: fetches `GET
  https://ollama.com/api/usage` with the omp-resolved credential as a Bearer
  header; validates every consumed field with `isOllamaUsagePayload` (hand-rolled
  guard, same style as `isCatalog`) and maps windows to percent `UsageLimit`s
  plus a USD activity row when the 4-week cost is nonzero. Registered via
  `registerProvider({ usage })` → omp routes it to
  `AuthStorage.setRuntimeUsageProvider` (session-lifetime override of omp's
  built-in "no quota API" ollama-cloud stub). The standalone `omp usage` CLI
  does not load extensions, so it keeps the stub regardless of the knob. Never
  throws; null on any failure (omp applies its own cool-down/last-good handling).
- `src/self-update.ts` — probe-only: npm installs under `~/.omp/plugins/node_modules` only; dev checkouts (`omp plugin link`) opt out. Never mutates the install, never throws.

Deliberately not ported from the opencode predecessor: `/model` and a `/stats` dialog (omp ships its own).

## Key Directories

- `src/` — all source, flat, ~9 modules + 6 colocated test files. No subdirectories.
- `.github/workflows/publish.yml` — npm publish on `v*` tags.

## Development Commands

```sh
bun install            # deps (bun.lock committed)
bun test               # full suite
bun test src/catalog.test.ts   # single file
bun run typecheck      # tsc --noEmit
omp plugin link .      # live checkout; reload = new omp process
```

No lint/format script. Release = push tag `v*`; CI gates on typecheck + full `bun test` before `npm publish --access public` (OIDC trusted publishing, Node 24 + Bun).

## Code Conventions & Common Patterns

- **Never-throw, best-effort everywhere**: catalog fetch → `null` on failure, disk cache/recost/self-update swallow all errors. The plugin must never crash the host on a down CDN or missing DB.
- **Hand-rolled type guards, no schema library**: `isCatalog`, `unknown`-narrowing helpers (`positiveFinite`, `isNonEmptyString`, `isStringArray`); branded outcome unions (`CostFixOutcome = "patched" | "not-found" | "unavailable"`, `SelfUpdateOutcome`).
- **Injectable seams for tests**: optional params (`readFileFn`, `writeFileFn`, `fetchFn`, `resetOffsetsFn`) — never a mocking framework, never mocked fs.
- **Sync fs for hot rewrite paths** (`cost-fix.ts`, `recost.ts`); async for orchestration (`loadCatalog`, `runSelfUpdate`). `void promise` fire-and-forget for non-critical work (cache write, self-update).
- **Config via env knobs, read once at factory time** (omp passes no factory options): `OMP_OLLAMA_CLOUD_PRICING`, `OMP_OLLAMA_CLOUD_COST_FIX`, `OMP_OLLAMA_CLOUD_STATS`, `OMP_OLLAMA_CLOUD_USAGE` — all default on; `off`/`0`/`false`/`no` disable. `OMP_OLLAMA_CLOUD_BASE_URL` overrides the provider endpoint (default `https://ollama.com`), used by ollama-cloud-meter's quick configuration; omp eagerly loads `~/.omp/agent/.env`.
- **Wire names stay untranslated**: artifact fields (`x_ollama`, `cache_read`, `models_hash`), session fingerprints (`"provider":"ollama-cloud"`), omp API fields (`cost.cacheRead`). See `GLOSSARY.md`.

## Important Files

- `src/index.ts` — plugin entry; wiring and session state live here.
- `src/catalog.ts` — the widest module; validation gate `isCatalog` is the contract with the upstream catalog repo's `schemas/catalog.schema.json`.
- `tsconfig.json` — strict, ESNext, `allowImportingTsExtensions` (imports use explicit `.ts`), `noEmit`.
- `README.md` / `GLOSSARY.md` — user-facing behavior + anglicization notes.

## Runtime/Tooling Preferences

- **Bun required**: `bun:test`, `bun:sqlite` (`recost.ts`), `bun.lock`; omp itself is Bun-based. Do not port to Node-only APIs.
- TypeScript strict; imports include `.ts` extensions; `types: ["bun"]`.
- Peer dependency on `@oh-my-pi/pi-coding-agent` — never bundle it.

## Testing & QA

- `bun test`, colocated `src/*.test.ts`. Two styles: pure-function tests with inline fixture builders (`entry()`, `sessionLine()`, `docWith()`), and real-FS integration tests using `node:fs mkdtempSync` under `os.tmpdir()` + real `bun:sqlite` temp DBs.
- Test behavior contracts, not implementation: e.g. `fixSessionFileCosts` statuses, TPS/TTFT widget line (`"66.7 tok/s · TTFT 400 ms"` is a ratified cross-module contract), `file_offsets` reset scope.
- Both typecheck and the full suite are hard release gates; keep them green on every commit you push a tag from.
