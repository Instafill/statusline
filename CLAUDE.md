# CLAUDE.md — statusline

Local-only observer of Claude Code sessions. Hooks forward every hook event to
a spool; a watcher folds them into per-session state, classifies the
professional work performed (one LLM call per session via the local `claude`
CLI), groups sessions into projects, and serves a diagnostic UI at
http://127.0.0.1:45817.

```
Claude Code session → hooks/hook-forward.js → ~/.statusline/spool/new/
  → watcher (fold events → session state) → digest → claude -p (opus, low effort)
  → evidence merge → project grouping → web UI / status-line segment
```

This repo is the **client**, and it is the whole product on a machine: it works
standalone, with no server anywhere. Team mode is an opt-in second egress
channel that points it at a deployment; that server is a separate application
and is not in this repo.

**`ARCHITECTURE.md`** explains why the aggregation model is shaped this way
(one LLM call per session, everything above it free and re-derivable), what it
costs, and where it stops scaling — read it before changing what gets captured
or how experience is counted.

## Hard rules — do not break these

1. **Zero runtime dependencies.** Everything under `src/`, `hooks/`,
   `statusline-segment.js` and `test/` is built-in Node only (`http`, `fs`,
   `node:test`) — never add an npm package, and `package.json` has no
   `dependencies`.
2. **Privacy.** Tool *outputs* and file *contents* are never captured — only
   prompts, paths, tool names, and secret-masked commands. Exactly TWO network
   egress channels exist: (a) the classifier call through the user's own
   `claude` CLI, and (b) **only when `upload.enabled` is set in config** (off
   by default), session-doc and heartbeat uploads to the configured team
   endpoint. **Uploads are ALWAYS content-stripped (hard rule, not
   configurable): prompt text, assistant excerpts, digest text, raw command
   text and search queries never leave the machine on channel (b)** — only
   classification results, tool evidence, counts, paths and git identity do
   (`src/upload/strip.js` is THE definition; the server strips again as the
   trust boundary, so an old client cannot leak either). The one-time,
   user-initiated `cli.js join` enrollment call and doctor's connectivity probe
   hit the same host and are part of channel (b) — joining is what *creates*
   the opt-in. Every attempt on either channel — success or failure — must be
   recorded in `egress.jsonl` (`kind:"upload"` batch-level for uploads,
   `kind:"enroll"` for joins). Nothing else may touch the network. A disabled
   install loads zero upload code. No telemetry.
3. **`~/.claude/settings.json` is shared and live.** It carries third-party
   hooks and user config. Only modify it through `src/installer.js` (strictly
   additive, manifest-scoped, backup + post-write verify + restore on failure).
   Never hand-edit or rewrite it. A **plugin install must not touch it at all**
   — Claude Code loads `hooks/hooks.json` directly.
4. **Session state is event-sourced.** `sessions/<sid>.events.jsonl` is the
   source of truth; derived `<sid>.json` is always re-folded from it (dedupe
   by event id), never incrementally mutated. Fields owned by the
   classification pipeline are listed in `CLASSIFY_FIELDS` and survive
   re-folds.
5. **`hooks/hook-forward.js` and `statusline-segment.js` are standalone.**
   Core modules only, no imports from `src/` — they run inside every session
   while the repo may be mid-edit or moved. hook-forward must always exit 0,
   silently, fast. The segment must never throw and does exactly one small
   file read (no scans, no HTTP, no subprocesses).
6. **Self-observation guard (three layers).** The classifier spawns `claude`
   with `STATUSLINE_SELF=1` (checked on hook-forward's first line),
   `--safe-mode`, and cwd = data dir. Don't weaken any layer or the watcher
   will classify its own classifier calls.

## Two install shapes, one capture

The same hook set reaches Claude Code two ways, and both must stay in lockstep
(`test/plugin.test.js` fails the build if they drift):

- **Plugin** — `hooks/hooks.json` + `.claude-plugin/plugin.json`, installed via
  `/plugin marketplace add Instafill/statusline`. Claude Code registers the
  hooks itself from `${CLAUDE_PLUGIN_ROOT}`; `settings.json` is never touched.
  The repo is also its own marketplace (`.claude-plugin/marketplace.json`,
  `source: "./"`), so a public repo is the entire distribution channel — no
  registry, no review, nobody's permission.
- **Clone** — `install.ps1` / `install.sh` / `cli.js install` writes the hook
  entries into `~/.claude/settings.json` with the checkout's absolute path.

Because a plugin install lands in a **versioned** directory
(`~/.claude/plugins/cache/statusline/statusline/<version>/`) that changes on
every update, nothing outside the data dir may embed the agent's path:
`src/agent-root.js` records the current root in `~/.statusline/agent.json`
(written by every `cli.js` command and by hook-forward on SessionStart) and
autostart points at a generated launcher in the data dir that resolves it at
launch time. Version bumps go in `package.json`, `.claude-plugin/plugin.json`
and `.claude-plugin/marketplace.json` together.

## Key facts and gotchas

- **Data dir:** `~/.statusline` (override: `STATUSLINE_HOME`).
- **Hooks are installed live on a dev machine.** Editing `hook-forward.js`
  takes effect immediately in every session. Changes under `src/` need a
  watcher restart: kill the pid in `~/.statusline/watcher.lock`, then
  `node src/cli.js start` (single instance enforced via lockfile + health
  probe; startup demotes sessions stuck `pending` to `stale`).
- **Moving a clone breaks its installed hook command** (absolute path
  embedded) — re-run `node src/cli.js install`, which repoints entries left by
  another checkout instead of skipping them; `doctor` reports the real
  settings.json state rather than trusting the manifest.
- **SessionEnd is unreliable** (shared ~1.5s hook budget, abandoned sessions).
  The 60s idle tick (`idle_minutes`, default 10) is the primary classification
  trigger; SessionEnd is only an accelerator.
- **Windows quirks:** `fs.watch` drops events — the periodic spool rescan is
  the correctness mechanism; the classifier prompt is delivered via stdin
  (argv quoting is unsafe); child kill uses `taskkill /T /F`; the
  `claude -p --output-format json` result is often fence-wrapped despite
  instructions — `extractJsonObject` strips fences and does balanced-brace
  extraction.
- **Classification lifecycle:** `unclassified → pending → classified`
  (or `classification_failed`); `stale` after ≥`reclassify_min_new_turns`
  (5) new turns or a SessionEnd after classification. Triggers: session_end
  (≥1 prompt), idle (≥1 completed turn), manual/cli (bypasses eligibility).
  Queue concurrency is 1. Auth backoff pauses automatic classification after
  3 consecutive `auth_error`s.
- **Inheritance (`src/classify/inherit.js`):** resume/compact/fork sessions
  reuse the project's most recent real LLM classification (≤72h, tech-token
  overlap ≥0.5) instead of spending a call — marked
  `_meta.classifier: "inherited"`; never chains from inherited/heuristic
  donors; manual triggers and stale sessions always go to the real classifier.
- **Heuristic fallback (`src/classify/heuristic.js`):** when the classifier is
  unreachable, a deterministic low-confidence (0.25) classification is stored
  (category from project vote history, technologies from tool evidence) with
  `_meta.classifier: "heuristic"`; the scheduler upgrades it once the
  classifier works again (attempts spaced ≥30 min).
- **Evidence merge (`src/evidence.js`):** tool evidence (EDITED-file
  extensions, command first-tokens, MCP server names, observed dependency
  installs) forces `hands_on` with `tool:…` basis; zero-tool sessions are
  capped at `discussed`; `verified: true` only with tool corroboration —
  unverified hands_on renders dashed with `?` in the UI at BOTH session and
  project level. Two rules are load-bearing: **read-only file access never
  corroborates** (`Read` feeds `tools.extensions_read`, which proves nothing),
  and **matching is exact on canonical names** (no substring — "Java" can't
  ride on javascript evidence). `classification.technologies` is DERIVED:
  every fold recomputes it from `technologies_raw` (the LLM's untouched
  claims) + state.tools + the normalization tables, so table updates correct
  all history with zero classifier calls. Zero-**turn** sessions (a prompt but
  no completed reply) get `work_depth` capped at `shallow` and confidence at
  0.5 (`applyZeroTurnCaps` — deterministic, because model draws vary).
  Classifier expense (cost + tokens, summed over retries) is stored on `_meta`.
- **Normalization tables are data, not code (`src/tech-normalize.js`):** the
  alias/ext/cmd tables ship as repo defaults and are overlaid by a
  server-distributed team config — **the only distribution channel is the
  ingest ACK** (the uploader's existing POST; no new egress, nothing on
  disabled installs). The overlay is validated with strict charset/size caps
  (`validateOverlay`) because it crosses a trust boundary. It lands in
  `~/.statusline/team-config.json`; on a version change the watcher re-derives
  every classified session and the uploader's sha check re-uploads exactly what
  changed. Keep the client thin: grow these tables, don't add matching logic.
- **Git capture (`src/util/gitroot.js`):** per cwd, `gitInfo` yields
  `git_root`, `git_worktree` (linked worktree's name), `git_main_root` (the
  PARENT repo root when in a linked worktree — grouping folds the worktree
  into the parent project, parent ids unchanged), and `git_origin`
  (`remote.origin.url`, **credential-stripped before storage** — identifies
  the same repo across machines/checkout paths). Re-folds fill new fields
  retroactively while the repo exists on disk.
- **Aggregation foundation (session → project → practitioner):** grouping-core
  turns catch-all home-dir / no-cwd sessions into flagged per-session
  **singletons** (`key.kind:'session'`, rendered only as one "Miscellaneous
  sessions" list, never counted as projects) and applies the **engagement
  registry** (`corrections.engagements` locally): `eng_` ids claim projects by
  RAW keys (git_root paths / origin URLs) normalized at match time with the
  consumer's `normKey`; folded projects carry `engagement_id`/
  `engagement_kind` and the registry name (which outranks a local rename).
  Every project emits a per-session `membership` basis map
  (`git_root|worktree|cwd_absorbed|cwd|singleton|manual`) plus depths/via/
  active_days/machine_ids distributions, and `aggregate.technologies` is an
  **array** keyed by `canonical`, each entry carrying `substantive_sessions`,
  `first_at`/`last_at`, and a ≤25-row per-session evidence trace (counts stay
  exact). Merge suggestions: a shared normalized origin ALONE crosses the
  (0.5) threshold. **Experience** (`src/experience-core.js`, pure): reduces
  WITHIN a project first, then counts DISTINCT PROJECTS — session volume can
  never inflate; learning/personal/unclassified are tallied in
  `totals.excluded`, never as capability experience (user labels win both
  directions); all singleton work combined earns at most ONE flagged `misc`
  project credit; uncertainty rides raw (verified tiers, heuristic/inherited
  provenance, min confidence, membership kind, provisional identity). Surface:
  `GET /api/experience` + Experience tab, computed from files.
- **Pseudo-prompts are filtered:** UserPromptSubmit events starting with
  `<task-notification`, `<command-name`, `<local-command`, or
  `<system-reminder` never count as prompts/turns (`SYSTEM_PROMPT_RE` in
  `src/watcher/sessions.js`).
- **`/statusline` skill (`skills/statusline/`).** Teaches any Claude Code
  session how to read and operate an install: what the data means, how to
  answer "what did I work on" / "what can I claim", how to finish setup
  (autostart, join) and the troubleshooting tree. A plugin install gets it
  automatically (plugins scan `skills/`, namespaced
  `/statusline:statusline`); a clone install links the directory to
  `~/.claude/skills/statusline`. It ships a read-only helper, **`sl.js`, and
  the SKILL.md forbids inline `node -e` snippets** — PowerShell strips double
  quotes out of native-command arguments, so any one-liner carrying a Windows
  path or JSON mangles silently in exactly the environment we run in.
  `test/skill.test.js` guards the frontmatter, the subcommand list and that
  rule, because a malformed skill does not error — it just never loads.
- **Attention beep lives in its own repo**
  ([ogamaniuk/statusline-beep](https://github.com/ogamaniuk/statusline-beep),
  off by default) — not in this one. It has no dependency on statusline beyond
  reading the `beep` block of `~/.statusline/config.json` (which this repo owns,
  since that is where it is configured and where the Settings panel edits it).
  **statusline does not register `Notification` at all** — nothing in the fold
  ever consumed it, so it spooled an event nobody read on every permission
  prompt and idle nudge. `cli.js install` prunes our own entries a build no
  longer registers, so upgrading removes stale ones by itself.
- **UI:** vanilla JS as native ES modules (no build step, no bundler), served
  from `public/`. `js/app.js` registers views with `js/router.js`; views live in
  `js/views/` and share `js/core.js` (escaping, API client, formatting) and
  `js/components.js` (badges, chips, meta grid, liveness, outlook). Views build
  HTML strings and must escape through `esc()`. POSTs require the
  `X-Statusline: 1` header (CSRF guard); a Host-header allowlist guards DNS
  rebinding; the server binds 127.0.0.1 only. Static-file changes are live on
  refresh; API changes need a watcher restart.
- **Bootstrap 5, vendored (`public/vendor/`), and REAL URLs.** The look comes
  from stock Bootstrap in dark mode (`data-bs-theme="dark"`); `style.css` is a
  thin layer that only sets Bootstrap's own variables and adds what Bootstrap
  has no component for (evidence chips, liveness dots, project accents,
  meta-grid). Prefer a Bootstrap class over a new rule — and note `.row` is
  Bootstrap's flex grid, so clickable table rows are `tr.rowlink`. The CSS/JS
  are **served by the app, never a CDN** (rule 2 egress + the local UI must work
  offline). Routing is the History API, not `#fragments`: `/sessions`,
  `/session/<id>`, … The server serves the shell for an explicit `APP_PATHS`
  list (never a catch-all, so typos still 404), and `router.js` intercepts
  same-origin link clicks, exports `navigate()` for programmatic moves, and
  rewrites a legacy `#view/arg` bookmark to its path once. Correct the URL in
  place — never by re-entering `render()`.
- **Status line integration:** the watcher writes a `summary.json` rollup
  (`src/status-summary.js`) so `statusline-segment.js` can render a per-session
  segment with a single file read. It is not registered automatically — a
  plugin may not silently replace the user's own status line.
- **Team upload (opt-in, `src/upload/`):** with `upload.{enabled,endpoint,token}`
  set, the watcher POSTs **content-stripped** session docs (strip.js — see
  rule 2; classification + tool evidence + metadata, never prompt text) +
  5-min heartbeats to the deployment's ingest API. Change detection is a sha
  over the doc minus `updated_at`/`outlook`/`uploaded_at` (those churn without
  new information), recorded in `upload-state.json` only after the server ACKs;
  the 60s reconcile scan of session files is the correctness mechanism (dirty
  set is re-derivable — no durable queue). Machine identity lives in
  `machine.json` (random UUID, generated once). Enrollment (`cli.js join`)
  exchanges a single-use code for a per-machine credential. Session state files
  are never touched by the uploader.

## Commands

| Command | Purpose |
|---|---|
| `node src/cli.js install` / `uninstall` | Add/remove hook entries in `~/.claude/settings.json` (backed up, idempotent, repoints another checkout's entries) |
| `node src/cli.js start` | Run watcher + UI (foreground) |
| `node src/cli.js autostart [--off\|--status]` | Start watcher at login (via the data-dir launcher) |
| `node src/cli.js doctor [--no-auth]` | Preflight checks with a named fix per failure (`--no-auth` skips the real LLM round-trip) |
| `node src/cli.js status` | Installer/watcher/spool status |
| `node src/cli.js digest <sid>` | Print the digest that WOULD be sent — nothing is sent |
| `node src/cli.js classify <sid>` | Classify one session now (one real LLM call) |
| `node src/cli.js recompute` | Recompute project grouping |
| `node src/cli.js refold [sid]` | Re-derive session state from event logs (all or one) — run after a `deriveState` change |
| `node src/cli.js join <url> <code>` | Enroll this machine with a team deployment (one-time; per-machine credential, enables uploads) |
| `npm test` | Full test suite, no LLM calls, no network |
| `install.ps1` / `install.sh` | Bootstrap: verify Node, install hooks, autostart, doctor, open UI |

## Layout

```
.claude-plugin/           plugin.json + marketplace.json (this repo is its own
                          marketplace: source "./")
hooks/hook-forward.js     standalone spool writer (runs in every session)
hooks/hooks.json          plugin hook registration (${CLAUDE_PLUGIN_ROOT})
statusline-segment.js     standalone status-line segment renderer
skills/statusline/        the `/statusline` skill: SKILL.md + sl.js (read-only)
src/cli.js                command dispatch
src/paths.js              data-dir layout, legacy migration, sanitized session paths
src/agent-root.js         records where the agent lives + the autostart launcher
src/config.js             DEFAULTS + ~/.statusline/config.json overlay (deep merge)
src/installer.js          settings.json backup/merge/verify/uninstall (highest blast radius)
src/watcher/              index (lock, drain loop, recovery), spool, sessions (fold),
                          transcript (tail reader), scheduler (triggers/queue)
src/classify/             classifier (adapters, retries), claude-cli, prompt,
                          schema (validation), inherit, heuristic, egress, run
src/evidence.js           deterministic evidence merge + fold-time technology
                          derivation from technologies_raw
src/tech-normalize.js     canonical tech naming; tables-as-data (repo defaults +
                          server overlay) — pure
src/team-config.js        validated local overlay store, fed exclusively by the ingest ACK
src/grouping.js           local grouping wrapper (corrections I/O, persistence, mutations)
src/grouping-core.js      pure grouping algorithm — injectable path normalization;
                          worktree folding, singletons, engagement overlay,
                          membership bases, per-capability evidence traces
src/experience-core.js    pure practitioner-experience aggregation (distinct
                          projects, never sessions)
src/session-view.js       liveness + classification outlook
src/upload/               team uploader: identity (machine.json UUID), join
                          (one-time enrollment via /v1/enroll), strip (THE
                          content-stripping definition), index (sha change
                          detection, debounced batches, 60s reconcile,
                          heartbeats, egress logging) — loaded only when enabled
src/server/               http (hardening, static, routes), api (JSON handlers)
src/autostart.js, src/doctor.js, src/status-summary.js, src/util/
public/                   index.html, style.css (thin layer on Bootstrap),
                          vendor/bootstrap.min.css + .bundle.min.js (vendored),
                          js/{app,router,core,components}.js,
                          js/views/{sessions,session,projects,experience,egress,settings}.js
test/                     node:test suites + fixture copy of a settings.json
                          carrying third-party hooks
```

## Testing

Tests isolate completely by setting `process.env.STATUSLINE_HOME` to a fresh
`mkdtemp` directory **before requiring anything from `src/`** — follow that
pattern in new test files or you will read/write the real data dir. The
installer suite runs against `test/fixtures/settings.pixel.json` (a settings.json
carrying third-party hooks) and asserts byte-identical preservation of
everything it doesn't own. No test may invoke the real classifier; exercise
that path manually with `node src/cli.js classify <sid>`. User corrections
always win: any new derived data must flow through `corrections.json` overlays
on recompute, never overwrite them.
