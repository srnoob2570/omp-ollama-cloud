# Anglicize working note

Inventory (18 tracked files) and the term table for unifying the repo into
English. One English equivalent per source term.

## Glossary

| Source term | English | Where |
|---|---|---|
| familia | family | id base without the `[:tag]` suffix; identifier already `family` (`CatalogModel.family`, `familyOf`) |

Wire names stay untouched: artifact fields (`tool_call`, `release_date`,
`cache_read`, `x_ollama`, `models_hash`, `generated_at`, `ollama_family`),
session-line fingerprints (`"provider":"ollama-cloud"`, `ZERO_COST_FINGERPRINT`),
omp API fields (`cost.cacheRead`, `usage.output`), `stats.db` table
(`file_offsets`), registry URL. `wVe` (cost-fix.ts) is omp's internal pricing
symbol, quoted, not translated.

## Inventory

| File | Class | Foreign content |
|---|---|---|
| .gitignore | preserve | — |
| README.md | preserve | already English |
| bun.lock | preserve | generated |
| package.json | preserve | English metadata |
| tsconfig.json | preserve | config only |
| src/catalog.ts | mixed | `familia[:tag]` in two comments (L13, L173) |
| src/catalog.test.ts | mixed | `familia[:tag]` in a test title (L183) |
| src/cost-fix.ts | preserve | English |
| src/cost-fix.test.ts | preserve | English |
| src/index.ts | preserve | English (UI strings included) |
| src/models.ts | preserve | English |
| src/models.test.ts | preserve | English |
| src/recost.ts | preserve | English |
| src/recost.test.ts | preserve | English |
| src/self-update.ts | preserve | English |
| src/self-update.test.ts | preserve | English |
| src/stats.ts | preserve | English |
| src/widget.ts | preserve | English |

## Plan

Prose pass: translate the three `familia[:tag]` mentions to `family[:tag]`.
Identifier pass: none needed (identifiers, file and directory names are
already English); then `bun test` + `bun run typecheck`, then the sweep.