# statusline — Claude Code Capability Watcher

Observes your Claude Code sessions through supported hooks (Windows and macOS)
and turns them into structured professional-work capability classifications,
grouped into real-world projects.

```
Claude Code session → hooks → spool → watcher → session reconstruction
      → semantic classification (LLM) → project grouping → local web UI
```

By default everything stays on this machine, and the **only** network egress is
the classification call, which goes through your own local `claude` CLI (your
existing Claude Code login) and is recorded in a visible egress log — one entry
per call, with the exact payload hash.

An **opt-in team mode** adds a second egress channel: when `upload.enabled` is
set, the watcher pushes each session to a shared cloud endpoint so an internal
team can see all its machines' work in one place (see
[Team view](#team-view-optional)). It is off unless you configure it, and every
upload is written to the same egress log.

## Before you install — what this observes

statusline watches **every Claude Code session on your machine**, in every
directory, including personal and side projects. For each finished session it
sends a **text digest** — prompts, file paths, commands run, short assistant
excerpts — to an LLM through *your own* Claude Code login.

- Tool **outputs** and file **contents** are never captured. Paths, tool names
  and (secret-masked) commands are.
- Every LLM call is recorded in the **Egress** tab with the exact payload hash.
- Label any session **Ignore** to exclude it, or run `uninstall` to stop
  everything. All data is local, in `~/.statusline`; delete that directory to
  erase it.
- If you join a **team deployment**, your sessions' *classification results
  and metadata* — categories, technologies with evidence, counts, file paths,
  git identity — are uploaded to that team's endpoint. **Prompt text,
  assistant excerpts, digest text and command text never upload**; that is a
  hard rule enforced on both ends, not a setting. Who can see your session
  records is the org's policy: by default a member sees only their own and
  admins see everyone's. Nothing uploads until you enroll.

Read that paragraph before running the installer on a machine you use for
personal work.

## Requirements

- [Claude Code](https://claude.com/claude-code) installed and logged in
- Node.js 18+ with `node` on PATH — the installed hooks invoke it by bare name
- Windows or macOS

No npm dependencies at all: there is nothing to `npm install`. Everything
here runs on built-in Node modules.

## Install

Two ways in. Both end at the same place: hooks registered, watcher running at
login, UI on <http://127.0.0.1:45817>.

### As a Claude Code plugin (recommended)

In any Claude Code session:

```
/plugin marketplace add Instafill/statusline
/plugin install statusline@statusline
```

The repo is public, so this needs no GitHub account, no `gh` CLI and no
credentials — Claude Code clones it over plain HTTPS. Claude Code registers the
hooks itself, so `~/.claude/settings.json` is never modified by us, and
`/plugin update` is the whole update story.

One step remains, because a plugin cannot start a background service: from any
session, ask Claude to **`start the statusline watcher`** — the bundled
`/statusline:statusline` skill runs the setup for you (registers autostart,
starts the watcher, runs the preflight check). By hand it is:

```powershell
node "$env:USERPROFILE\.claude\plugins\cache\statusline\statusline\<version>\src\cli.js" autostart
```

### From a clone

Works with no plugin system involved, and is the path to take if you intend to
change the code.

**Windows**

```powershell
git clone https://github.com/Instafill/statusline.git
cd statusline
.\install.ps1
```

**macOS**

```bash
git clone https://github.com/Instafill/statusline.git
cd statusline
./install.sh
```

The script verifies Node, installs the hooks, registers the watcher to start at
login, runs the preflight checks, and opens the UI at
<http://127.0.0.1:45817>. It is safe to re-run at any time — including after
moving the checkout, which repoints the hooks at the new path. Useful flags:
`-NoAutostart` / `--no-autostart`, `-NoStart` / `--no-start`,
`-NoOpen` / `--no-open`.

Prefer to do it by hand? The script does no more than this:

```
node src/cli.js install      # add hook entries to ~/.claude/settings.json
node src/cli.js autostart    # start the watcher at login
node src/cli.js doctor       # verify the whole chain
```

Then use Claude Code normally, anywhere on the machine. Sessions appear in
the UI live; each one is classified automatically when it **ends** or has
been **idle ~10 minutes** (configurable) — never per-message.

## When something looks wrong

```
node src/cli.js doctor
```

It checks the Node runtime, that `claude` resolves and is **actually logged
in** (one real round-trip), that the hook entries are present and current, that
autostart is registered, and that the watcher is up — printing the exact fix for
anything that fails. Use `--no-auth` to skip the LLM call.

The most common failure by far is *the watcher isn't running*: hooks keep
spooling events safely, but nothing is ingested or classified, so the UI looks
frozen. `node src/cli.js autostart` is the durable fix.

## Updating

Plugin install:

```
/plugin update statusline@statusline
```

Clone install:

```
git pull
node src/cli.js install    # only needed if the hook set changed
```

You don't have to remember when that second line is needed — `doctor` and the
watcher's own startup output both flag an out-of-date install and tell you.
Re-running `install` is also how a moved or re-cloned checkout takes over: it
repoints the hook entries at the checkout you ran it from.

## Uninstall

Removes only statusline's own hook entries and leaves every other setting
byte-identical:

```
node src/cli.js autostart --off
node src/cli.js uninstall
```

## CLI

| Command | What it does |
|---|---|
| `node src\cli.js install` | Add hooks to `~\.claude\settings.json` (backup written first; idempotent) |
| `node src\cli.js uninstall` | Remove only statusline's hook entries |
| `node src\cli.js status` | Hook/watcher/spool status |
| `node src\cli.js start` | Run the watcher + local web UI |
| `node src\cli.js digest <session-id>` | Print the digest that WOULD be sent — nothing is sent |
| `node src\cli.js classify <session-id>` | Classify one session now (one LLM call) |
| `node src\cli.js recompute` | Recompute project grouping |
| `node src\cli.js refold [session-id]` | Re-derive session state from the event logs (after a capture change) |
| `node src\cli.js join <url> <code>` | Enroll this machine with a team deployment (one time) |
| `node src\cli.js doctor [--no-auth]` | Check the whole chain and name the fix for anything broken |
| `npm test` | Run the test suite (no LLM calls, no network) |

## How it works

- **Hooks** (`hooks\hook-forward.js`) — installed at the user level for
  `UserPromptSubmit`, `Stop`, `PostToolUse` (file/shell/web/MCP tools),
  `SessionStart`, `SessionEnd`. The hook script writes each event payload to
  `~\.statusline\spool\new\` and exits — always silent, always exit 0, `async`
  so it can never slow a session down. Events are never lost when the watcher
  isn't running; they sit in the spool until it starts.
- **Attention beep** (optional, off by default) — a separate Claude Code
  plugin, [`statusline-beep`](https://github.com/ogamaniuk/statusline-beep) —
  its own repo, so nothing about it runs unless you install it and nothing in
  this repo depends on it. Clone or link it into
  `~\.claude\skills\statusline-beep`, set `beep.enabled` to `true` in
  `~\.statusline\config.json`, and it plays a short
  tone whenever a session finishes a response or asks for a permission — so a
  session that needs you is audible across a wall of tabs. Pitch tells you
  *which* project (each repo hashes onto its own note) and the pattern tells
  you *what it wants*: one note for "ready to read", two lower notes for
  "blocked on you". Beeps from all tabs are debounced
  (`beep.min_interval_ms`), `beep.quiet_hours` (e.g. `["22:00", "08:00"]`)
  mutes it overnight, `beep.command` swaps in your own player, and
  `beep.notification_filter: "permission"` drops the idle nudge.
- **`/statusline` skill** (optional) — link `skills\statusline` to
  `~\.claude\skills\statusline` and any Claude Code session can answer "what
  did I work on this week", "what can I actually claim to know", and "why
  isn't this session classified" from your own data, with the verification
  caveats attached. It reads through a bundled read-only helper and never
  writes anything.
- **Watcher** (`node src\cli.js start`) — single instance; ingests the spool,
  appends each session's events to an append-only log, and re-derives session
  state from that log (restart-safe, duplicate-safe). Large values (file
  contents, oversized prompts) are pruned to short excerpts at ingest and
  credential-looking strings are masked.
- **Classification** — a digest (metadata, prompts, best-effort assistant
  excerpts from the local transcript, tool-activity summary) is built, capped
  (~10k chars), stored with its sha256, then sent through
  `claude -p --model opus --effort low --safe-mode --tools "" --no-session-persistence`.
  `--safe-mode` + a `STATUSLINE_SELF` guard prevent the watcher from observing
  its own classifier calls. Output is validated against a strict schema with
  one corrective retry. Each call's cost and token usage are recorded in
  `egress.jsonl` and on the classification itself (`_meta.cost_usd`).
- **Evidence merge** — LLM technology claims are combined with deterministic
  evidence (file extensions edited, commands run, MCP servers used,
  dependencies installed): tool evidence forces `hands_on`; a session with
  zero tool calls is capped at `discussed` no matter what the model claims.
  Every technology carries a `verified` flag — `true` means corroborated by
  tool evidence, `false` means the classifier's judgment alone (shown dashed
  with a `?` in the UI).
- **Inheritance** — a continuation session (resume / compact / fork) in a
  project with a recent LLM classification inherits it instead of spending a
  classifier call, unless its tool evidence diverges from the donor's
  technologies. Inherited results are marked and re-derive evidence levels
  from the new session's own activity; accumulating ~5 new turns makes the
  session stale and routes it to the real classifier.
- **Heuristic fallback** — when the classifier is unreachable (logged out,
  offline, timing out), the session still gets a deterministic low-confidence
  classification: category from the project's classification history,
  technologies from tool evidence. Marked `heuristic` in the UI and upgraded
  automatically once the classifier works again (attempts spaced ≥30 min).
- **Grouping** — sessions in the same git repo (or directory) group
  deterministically; similar projects elsewhere get *merge suggestions*
  scored on project-hint/tech/industry overlap, temporal proximity, and
  continuation signals. Your manual corrections (labels, field overrides,
  moves, renames, dismissals) live in `corrections.json` and always win.

## The UI (http://127.0.0.1:45817)

- **Sessions** — every observed session, its state, and its classification.
  Open one to see prompts, tool activity, the classification with
  per-technology evidence ("why"), the exact digest that was sent, and raw
  events. Label it (Client work / Internal / Learning / Personal / Ignore),
  correct fields, reassign its project, or re-classify.
- **Projects** — grouped sessions with aggregated detected capabilities and
  merge suggestions (Accept / Dismiss).
- **Egress log** — every LLM call that left the machine.
- **Settings** — hook status, config editing, privacy summary.

## Team view (optional)

Team mode collects sessions from **every machine in an org** into one shared
web app, so the team sees all its Claude Code work in one place. The local UI
keeps working exactly as before — it stays the machine-local diagnostic surface
(digest previews, egress audit, corrections, classify-now). The team UI is
**read-only**.

```
each machine's watcher → POST /v1/ingest (per-machine credential) → team UI
```

### Joining a deployment

Accounts are **invite-only** — there is no sign-up page and no shared token to
pass around.

1. Open the invite link an admin sends you and **sign in with Google**. That
   creates your account in their org and lands you on the **Install** page
   (`/install`), which already shows your single-use enroll command — and, from
   then on, the live status of every machine connected to you.
2. Install statusline if you have not already (above), then enroll this machine:
   ```
   node src/cli.js join <url> <code>
   ```
   From a plugin install, ask Claude to **`join <url> <code>`** and the skill
   runs it against the right path. A fresh clone can do both at once:
   ```
   git clone https://github.com/Instafill/statusline.git
   cd statusline
   .\install.ps1 -JoinUrl <url> -JoinCode <code>      # Windows
   ./install.sh --join <url> <code>                   # macOS
   ```
   Enrolling an install whose watcher is already running needs that watcher
   restarted afterwards (stop the pid in `~/.statusline/watcher.lock` and run
   `node src/cli.js start`, or log out and back in if autostart is on).

Enrollment writes a **credential belonging to that machine alone** into
`~/.statusline/config.json` and binds the machine to you, so your sessions are
attributed to you from the first heartbeat. An admin can revoke a single
machine without touching anyone else. `node src/cli.js doctor` verifies the
whole chain, including that the endpoint accepts your credential.

Uploads are always content-stripped — classifications, counts and tool
evidence flow; prompt text, assistant excerpts, digest text and shell
commands never do. This is not configurable, and the server strips again at
ingest so no client version can leak content. The credential is never
displayed in the UI.

Uploads are incremental: a session is re-sent only when its content actually
changes, a 60-second reconcile sweep catches anything missed (including
whatever accumulated while you were offline), and a heartbeat every 5 minutes
keeps the machine's status current. Every attempt — success or failure — is
recorded in the local **Egress** tab alongside the classifier calls.

### Running a deployment

The server side — ingest, accounts, the org-wide rollups — is a separate
application and is not part of this repo. This repo is the client: it works
entirely on its own, and team mode is an opt-in second egress channel it can be
pointed at.

## Contributing

Read **`CLAUDE.md`** first — it carries the hard rules, and breaking one is
the only way to do real damage here. The short version:

- **No npm dependencies.** Everything is built-in Node (`http`, `fs`,
  `node:test`). `package.json` has no `dependencies` and is meant to stay that
  way.
- **Privacy is a contract, not a preference.** Tool outputs and file contents
  are never captured, and only two channels may touch the network (the
  classifier through your own `claude` CLI, and opt-in team uploads/enrollment)
  — every attempt on either lands in `egress.jsonl`.
- **`~/.claude/settings.json` is shared and live.** Change it only through
  `src/installer.js`, never by hand.
- **Session state is event-sourced**: `<sid>.events.jsonl` is the truth and
  derived state is always re-folded from it.

`npm test` runs everything (no LLM calls, no network). Tests isolate by
setting `STATUSLINE_HOME` to a fresh temp dir **before requiring anything from
`src/`**; follow that or you will read and write your real data.

`ARCHITECTURE.md` explains why the aggregation model is shaped the way it is
(one LLM call per session, everything above it free and re-derivable) and where
it stops scaling — read it before changing what gets captured or how
experience is counted. `FOLLOWUPS.md` holds open work and deliberately
deferred decisions.

Two gotchas that bite everyone once: the **hooks on your machine are live**,
so editing `hooks/hook-forward.js` takes effect in your very next Claude Code
session; and changes under `src/` need a watcher restart (stop the pid in
`~/.statusline/watcher.lock`, then `node src/cli.js start`).

## Data & privacy

All state lives in `%USERPROFILE%\.statusline\` (spool, per-session event logs
and state, projects, corrections, egress log, settings backups). Tool
*outputs* and file *contents* are never captured — only tool names, commands
(secret-masked), and file paths. Delete the directory to erase everything.

Exactly two things can leave the machine, and both are logged in
`egress.jsonl`: the classifier call, and — only with `upload.enabled` — team
uploads. Raw event logs (`<session>.events.jsonl`) are never uploaded.

The classifier interface (`src\classify\classifier.js`) is deliberately
separated from the watcher so the `claude -p` adapter can be replaced by a
local model later without touching the rest of the app.

## Config

`~\.statusline\config.json` (editable in the Settings tab): `port`,
`idle_minutes`, `reclassify_min_new_turns`, digest caps, classifier
`model`/`timeout_ms`, `classifier.inherit`
(`enabled`/`max_age_hours`/`min_token_overlap`),
`classifier.heuristic_fallback`, spool rescan interval, retention windows, and
`upload` (`enabled`/`endpoint`/`token`/`debounce_ms` — see
[Team view](#team-view-optional); disabled by default).

## License

MIT — see [LICENSE](LICENSE).
