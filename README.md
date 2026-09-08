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

## Knobs

Environment variables (read once at startup):

| Variable | Default | Effect |
|---|---|---|
| `OMP_OLLAMA_CLOUD_PRICING` | `on` | `off` zeroes all cost blocks (counter at $0.00) |
| `OMP_OLLAMA_CLOUD_STATS` | `on` | `off` disables the live widget and collector |
| `OMP_OLLAMA_CLOUD_DEBUG` | unset | `on` logs one debug notification per completed assistant step |

Note: omp caches the dynamic model list per provider (SQLite, 24 h TTL) in
`~/.omp/agent/models.db`. After flipping `OMP_OLLAMA_CLOUD_PRICING`, run
`omp models refresh` to force a fresh fetch and see the change immediately.

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