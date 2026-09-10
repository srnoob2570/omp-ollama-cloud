# omp-ollama-cloud

oh-my-pi (omp) plugin that registers the Ollama Cloud provider with the model
catalog from
[srnoob2570/ollama-cloud-catalog](https://github.com/srnoob2570/ollama-cloud-catalog)
(official rate card, thinking efforts), adds a live streaming-stats widget
(tok/s, TTFT), and fetches real account quota from ollama.com's usage API
for omp's `/usage` surfaces.

Ported from [`@srnoob2570/opencode-ollama-cloud`](https://github.com/srnoob2570/opencode-ollama-cloud).
omp ships its own `/model` command, so that one is not ported.

## Install

```bash
omp plugin install @srnoob2570/omp-ollama-cloud
```

For development:

```bash
omp plugin link /path/to/omp-ollama-cloud
```

The plugin only supplies models and pricing; omp resolves the credential
itself. Set `OLLAMA_CLOUD_API_KEY`, or run `omp /login` and pick Ollama
Cloud.

## Models

The plugin replaces omp's built-in discovery list for `ollama-cloud` with
the published catalog, so `omp models` shows the real lineup: context and
max-output limits, thinking efforts, and image support per model.

![`omp models` listing 19 ollama-cloud models with context limits, thinking efforts, and image support](docs/images/command-omp-models.png)

## What it does

- Registers the `ollama-cloud` provider through `pi.registerProvider`, with
  `fetchDynamicModels` fed by the published catalog artifact. The catalog's
  models replace omp's built-in discovery list for this provider.
- Attaches each model's official rate card (USD per 1M tokens) from the
  artifact, so the cost counter, `/usage`, and omp-stats show real spend.
  These are the off-peak rates Ollama Cloud publishes; the cache-read rate
  maps to `cost.cacheRead`.
- Renders one line below the editor, `42.3 tok/s · TTFT 812 ms`, from omp's
  own `AssistantMessage` timing (`duration`, `ttft`); it never touches the
  wire. TPS is total output tokens over total stream time. Ollama Cloud
  flushes output in bursts, so a decode-only window would report burst
  speed, sometimes 500+ tok/s. TTFT is the simple mean per step.
  Only main-conversation ollama-cloud assistant steps count. Subagents run
  in their own runners, and title generation, auto-thinking, and compaction
  never reach the main runner as assistant messages.
- Probes the npm registry once per boot (npm installs only; dev checkouts
  are skipped). When a newer release exists, a second widget line names the
  version and the install command. The plugin never mutates its own install.
- Fetches the account's real quota from `GET https://ollama.com/api/usage`
  and feeds omp's normalized usage pipeline: `/usage` in the TUI and ACP
  sessions, the status-line footer (polled every 5 min), recorded usage
  history (`omp usage --history`), and credential health checks. Session and
  weekly windows render as percent bars with per-model request notes; a
  nonzero four-week activity cost adds a USD row. omp resolves the
  credential itself (stored login key or `OLLAMA_CLOUD_API_KEY`). The plugin
  sends the key only as a Bearer header to a pinned origin. It re-verifies
  the fetch target as `https://ollama.com/api/usage` immediately before
  every call, ignores `params.baseUrl` redirections, and never logs or
  persists the key. Every consumed response field is validated before use,
  and nothing from the response is executed or written to disk.
- Adds `/ollama-recost`, a one-shot sweep over every saved session file
  under `~/.omp/agent/sessions` (nested subagent transcripts included). It
  re-prices the `$0` ollama-cloud lines from the rate card, then drops
  omp-stats' incremental offsets so the dashboard's next sync re-parses the
  files (its upsert updates the cost columns). The offset reset covers
  every session file, including files that needed no rewrite, because a
  file can be fully priced while its dashboard rows were synced from an
  older snapshot, and re-parsing is idempotent. Reports files rewritten
  and requests re-priced.

## Usage surfaces

The `omp usage` CLI command prints the account's quota windows with
per-model request counts. It reads what an open omp session has already
fetched, so the numbers only appear while an omp window is open and has
queried the usage at least once. With no live session it shows the
built-in stub's "no limits reported". Use `omp usage --history` instead;
it works from the recorded snapshots alone.

![`omp usage` CLI output showing Ollama Cloud session and weekly quota bars](docs/images/command-omp-usage.png)

`omp usage --history` records snapshots and renders the trend per window:

![`omp usage --history` showing session and weekly usage peaks over 7 days](docs/images/command-omp-usage-history.png)


## Knobs

Environment variables, read once at startup. `off`, `0`, `false`, and `no`
all turn a knob off.

| Variable | Default | Effect |
|---|---|---|
| `OMP_OLLAMA_CLOUD_PRICING` | `on` | `off` zeroes every cost block (counter stays at $0.00) |
| `OMP_OLLAMA_CLOUD_STATS` | `on` | `off` disables the widget and the collector |
| `OMP_OLLAMA_CLOUD_COST_FIX` | `on` | `off` disables the session-cost patch (see below) |
| `OMP_OLLAMA_CLOUD_USAGE` | `on` | `off` restores omp's built-in stub (reports "no quota API") |

omp caches the dynamic model list per provider in `~/.omp/agent/models.db`
with a 24 h TTL. After flipping `OMP_OLLAMA_CLOUD_PRICING`, run
`omp models refresh` to force a fresh fetch and see the change immediately.

The extension system only runs inside sessions, so the standalone
`omp usage` CLI command keeps showing the built-in stub's "no limits
reported" for Ollama Cloud regardless of this knob; the session surfaces
(`/usage`, footer, `--history`) show the real numbers.

## Session cost patch

omp's `ollama-chat` adapter never prices usage. It writes `usage.cost` as
$0 for every request, so the cost counter, `/usage`, and omp-stats all
show $0 for Ollama Cloud. The plugin re-prices the affected session lines
at turn end from the model's rate card. `OMP_OLLAMA_CLOUD_COST_FIX=off`
disables the patch. The plugin never touches lines that already carry a
non-zero cost, so the patch becomes a no-op once upstream omp fixes the
adapter.

Because the patch rewrites lines in place (byte lengths change), the plugin
also resets the patched file's incremental offset in omp-stats' `stats.db`,
so the dashboard's next sync re-parses it. `/ollama-recost` does the same
for the full history. Lines from the turn in flight are priced when the
turn ends.

## Catalog upstream

Scheduled GitHub Actions in `srnoob2570/ollama-cloud-catalog` publish the
artifact: models.dev shape plus the `x_ollama` extension
(`reasoning_options`, quantization, rate card, hash gate). Two mirrors serve
the same file; the loader races them in parallel with a 5 s timeout each and
takes the first response that passes `isCatalog`. On total failure it falls
back to the disk cache at `~/.cache/omp-ollama-cloud/catalog.json`,
refreshed on every successful fetch. With no network and no cached copy the
provider lists no models until a fetch succeeds.

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