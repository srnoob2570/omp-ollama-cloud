# Changelog

## [0.1.1] - 2026-09-09

### Added

- Real account quota in omp's usage surfaces: `/usage` in sessions, the
  status-line footer (polled every 5 min), usage history, and credential
  health checks now read `GET https://ollama.com/api/usage`. Session and
  weekly windows render as percent bars with per-model request notes; a
  nonzero four-week activity cost adds a USD row. The API key is only ever
  sent as a Bearer header to the pinned `https://ollama.com` origin (the
  target is re-verified before every call) and is never logged or
  persisted. `OMP_OLLAMA_CLOUD_USAGE=off` restores omp's built-in stub.
  Note: the standalone `omp usage` CLI command does not load extensions,
  so it keeps reporting "no limits reported" for Ollama Cloud; use the
  in-session surfaces.

### Fixed

- Streaming stats measure every provider's assistant steps again; a
  provider filter added during the cost-fix work had narrowed the widget
  to ollama-cloud only. Rate-card capture stays scoped to ollama-cloud,
  where omp's $0 pricing bug makes the patch necessary.

**Full changelog:** https://github.com/srnoob2570/omp-ollama-cloud/commits/v0.1.1

## [0.1.0] - 2026-09-08

First tagged release. Everything below ships in one go.

### Added

- Ollama Cloud provider for omp: model catalog from the
  `srnoob2570/ollama-cloud-catalog` artifact (two CDN mirrors raced in
  parallel, 5 s timeout, disk cache fallback), official USD rate card per
  model, thinking efforts, and text/image input mapping. Costs show up in
  the cost counter, `/usage`, and omp-stats instead of $0.
- Live streaming-stats widget: one line under the editor,
  `42.3 tok/s · TTFT 812 ms`, from omp's own `AssistantMessage` timing.
  TPS uses total stream time because Ollama Cloud flushes output in
  bursts; decode-only math would report 500+ tok/s. Main-conversation
  steps only; subagents and title generation never reach the collector.
- Session cost patch: omp's `ollama-chat` adapter persists every request
  with `usage.cost = $0`. The plugin re-prices affected lines at turn end
  from the rate card, resets the file's omp-stats offset so the dashboard
  re-parses it, and adds `/ollama-recost` to sweep every saved session
  (subagent transcripts included) in one shot. Lines that already carry a
  non-zero cost are never touched, so the patch becomes a no-op once omp
  fixes the adapter.
- Update probe: one npm registry check per boot (npm installs only; dev
  checkouts opt out). When a newer release exists, a second widget line
  names the version and the install command. The plugin never mutates its
  own install.

**Full changelog:** https://github.com/srnoob2570/omp-ollama-cloud/commits/v0.1.0