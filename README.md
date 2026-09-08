# omp-ollama-cloud

oh-my-pi (omp) plugin that registers the **Ollama Cloud** provider with the
always-up-to-date model catalog from
[srnoob2570/ollama-cloud-catalog](https://github.com/srnoob2570/ollama-cloud-catalog)
— official pricing, quantization metadata, thinking efforts — plus a live
streaming-stats widget (tok/s · TTFT · session average).

Ported from [`@srnoob2570/opencode-ollama-cloud`](https://github.com/srnoob2570/opencode-ollama-cloud).
The opencode `/model` command is deliberately not ported (omp ships its own).

## Install

```bash
omp plugin install @srnoob2570/omp-ollama-cloud
```

or, for development:

```bash
omp plugin link /path/to/omp-ollama-cloud
```

omp resolves your existing `OLLAMA_CLOUD_API_KEY` credential for requests
(log in with `omp /login` if you haven't); the plugin itself only supplies
models and pricing.

## What it does

- **Provider catalog**: registers the `ollama-cloud` provider via
  `pi.registerProvider` with `fetchDynamicModels` fed by the published
  catalog artifact (jsDelivr mirror-race, 5 s timeout, 24 h disk cache at
  `~/.cache/omp-ollama-cloud/catalog.json`). The catalog's models replace
  the provider's built-in discovery list.
- **Official pricing**: each model carries its rate card (USD per 1M tokens)
  from the artifact, so omp's cost counter and `/usage` show real spend.
- **Live stats widget**: below the editor, one line —
  `N.N tok/s · TTFT NNNN ms · Session average` — token-weighted TPS and
  simple-mean TTFT across main-conversation LLM steps of the current
  session, measured from omp's own `AssistantMessage` timing (no wire
  interception). Subagent steps, title generation, auto-thinking, and
  compaction are excluded by construction.
- **Self-update check**: one registry probe per boot; if a newer version is
  published, a second widget line points at the install command (the
  plugin never mutates its own install).
- **`/ollama-recost` command**: one-shot sweep over every saved session
  (`~/.omp/agent/sessions/*/*.jsonl`) re-pricing the $0 ollama-cloud lines
  from the catalog rate card, then dropping the affected files' incremental
  offsets in omp-stats' `stats.db` so its next sync re-parses them (its
  upsert updates the cost columns). Reports files rewritten and requests
  re-priced.

## Knobs

Environment variables (read once at startup):

| Variable | Default | Effect |
|---|---|---|
| `OMP_OLLAMA_CLOUD_PRICING` | `on` | `off` zeroes all cost blocks (counter at $0.00) |
| `OMP_OLLAMA_CLOUD_STATS` | `on` | `off` disables the live widget and collector |
| `OMP_OLLAMA_CLOUD_COST_FIX` | `on` | `off` disables the session-cost patch (see below) |
| `OMP_OLLAMA_CLOUD_DEBUG` | unset | `on` logs one debug notification per completed assistant step |

Note: omp caches the dynamic model list per provider (SQLite, 24 h TTL) in
`~/.omp/agent/models.db`. After flipping `OMP_OLLAMA_CLOUD_PRICING`, run
`omp models refresh` to force a fresh fetch and see the change immediately.

### Session cost patch

omp's `ollama-chat` adapter persists `usage.cost` as $0 for every request
(it never prices the usage it builds; other adapters do), so omp's cost
counter, `/usage`, and the `omp-stats` dashboard all show $0 for Ollama
Cloud. This plugin re-prices the affected session lines at turn end from the
model's rate card. `OMP_OLLAMA_CLOUD_COST_FIX=off` disables the patch. Once
upstream omp fixes the adapter, the patch becomes a no-op: lines already
carrying a non-zero cost are never touched.

Because the patch rewrites lines in place (byte lengths change), the plugin
also resets the file's incremental offset in omp-stats' `stats.db` after each
patch, so the dashboard's next sync re-parses it. `/ollama-recost` does the
same for the full history. Lines from the turn currently in flight are priced
when the turn ends.

## Catalog upstream

The artifact is published by scheduled GitHub Actions in
`srnoob2570/ollama-cloud-catalog`: models.dev shape plus the `x_ollama`
extension (`reasoning_options`, `quantization`, rate card, hash gate).
Two mirrors, same file; the loader validates with `isCatalog` before use and
falls back to the disk cache on network failure (first boot without cache
falls back to omp's bundled models at $0).

## Development

```bash
bun install
bun test
bun run typecheck
```

`omp plugin link .` for a live checkout; changes reload with a new omp
process.

## License

MIT