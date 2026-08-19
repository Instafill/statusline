---
name: statusline
description: Read and operate statusline, the local observer of Claude Code sessions on this machine. Use when the user asks what they worked on, which projects or technologies their sessions show, how much experience the data backs, why a session is unclassified or stuck pending, whether capture/the watcher/uploads are healthy, or asks to classify, re-fold, recompute or diagnose statusline — and to finish setup: start the watcher, register it at login, or join/connect/enroll this machine with a team deployment using an enroll code. Covers the ~/.statusline data dir and the local API on 127.0.0.1:45817.
user-invocable: true
allowed-tools:
  - Bash
  - Read
---

# statusline

statusline watches Claude Code sessions on this machine, classifies the
professional work in each one, groups sessions into projects, and derives
practitioner experience from them. Everything is local: `~/.statusline`
(override `STATUSLINE_HOME`), served at `http://127.0.0.1:45817`.

## Use the bundled helper

`sl.js` sits next to this file. It reads the local API and prints compact
tables. Prefer it over ad-hoc requests — it already knows the port, the field
names and the caveats worth surfacing.

```
node ~/.claude/skills/statusline/sl.js <command>
```

On Windows that path works from Git Bash; from PowerShell use
`node "$env:USERPROFILE\.claude\skills\statusline\sl.js"`. If this skill was
installed as part of a plugin, the script is at
`${CLAUDE_PLUGIN_ROOT}/skills/statusline/sl.js` instead.

| Command | Shows |
|---|---|
| `status` | capture health: hook entries, spool depth, scheduler, repo path, machine id |
| `sessions [days]` | one line per session active in the last N days (default 14) |
| `session <sid>` | full detail: counts, classification, technologies with evidence, classifier cost |
| `experience` | business capabilities (catalog) + technology facet, by distinct project |
| `projects` | project grouping, engagement ids, merge suggestions |
| `egress [n]` | recent network attempts — classifier calls and uploads |
| `repo` | path to the statusline checkout on this machine |
| `api <path>` | raw JSON from any endpoint, for anything the above does not cover |

Exit codes: `3` the watcher is not running, `4` the endpoint returned an
error (e.g. unknown session id), `2` bad arguments.

**Do not re-derive this data by parsing `~/.statusline/sessions/*.jsonl`.** The
watcher already folded the event logs into session state, grouped the projects
and computed experience; hand-parsing is slower and will disagree with the UI.

**Never write inline `node -e` one-liners against the API.** PowerShell strips
double quotes out of native-command arguments and shells disagree about
backslashes, so any snippet containing a Windows path or a JSON string mangles
silently. That is why `sl.js` exists. If you need something it does not do, use
`sl.js api /api/<path>` and post-process, or add a subcommand.

For writes (labels, project moves, recompute), POST to the API with the CSRF
header `X-Statusline: 1` — or, better, tell the user to use the UI at
<http://127.0.0.1:45817>, where corrections are one click.

## The CLI

`node <agent>/src/cli.js <command>`. Find `<agent>` with `sl.js repo` when the
watcher is up; when it is not (nothing to ask), read `root` from
`~/.statusline/agent.json`, which every install records. A plugin install lives
under `~/.claude/plugins/cache/statusline/statusline/<version>/` and the
current session can also use `${CLAUDE_PLUGIN_ROOT}`; a clone install lives
wherever the user cloned it.

| Command | Purpose |
|---|---|
| `doctor` | Preflight checks, each failure with a named fix. **Start here for any problem.** `--no-auth` skips the real LLM round-trip |
| `status` | Installer / watcher / spool status |
| `start` | Run the watcher + UI in the foreground |
| `classify <sid>` | Classify one session now — **costs one real LLM call** |
| `digest <sid>` | Print what would be sent; sends nothing |
| `refold [sid]` | Re-derive session state from the event logs |
| `recompute` | Recompute project grouping |
| `install` | Re-register hooks in `~/.claude/settings.json` — clone installs only, and it repoints entries left by another checkout (idempotent, backed up) |
| `autostart` | Start the watcher at every login. **The finishing step of a plugin install**, and the durable fix for "the watcher isn't running" |
| `join <url> <code>` | Enroll this machine with a team deployment using the single-use code from its Install page |

Hook changes take effect immediately in every session; changes under `src/`
need a watcher restart.

## Finishing an install

A plugin install registers the hooks by itself, but a plugin cannot start a
background service — so capture is running and nothing is being processed until
the watcher is registered:

```
node <agent>/src/cli.js autostart     # runs at every login from now on
node <agent>/src/cli.js doctor        # confirm the whole chain
```

`autostart` also re-points the login task at the copy you ran it from, so run
it again after a plugin update if `doctor` reports the recorded agent is gone.

**Joining a team deployment** (`join <url> <code>`): the user gets both from
their dashboard's Install page. Enrollment writes a credential for this machine
alone into `~/.statusline/config.json` and turns uploads on; a watcher that is
already running has to be restarted afterwards to pick it up. Uploads are
content-stripped by construction — say so if the user asks what leaves the
machine. Treat an enroll code like a password: it is single-use, but do not
echo it into files or commits.

## Answering the common questions

**"What did I work on?"** — `sl.js sessions 7`. Report `work_type` and the
project. Sessions whose state is not `classified` have no work description yet;
the helper counts them at the bottom — say so rather than quietly dropping
them.

**"What can I claim I know?"** — `sl.js experience`. Lead with the
**business capabilities** (what problems this person solves, from a fixed
catalog); technologies are the supporting facet, not the answer. Report
**distinct projects, not sessions**: the model deliberately reduces within a
project first, so session volume can never inflate a capability.

Repeat the qualifiers the helper prints rather than smoothing them over:
`← unverified` on a technology means the LLM claimed hands-on and no tool
evidence corroborates it; on a business capability, **`grounded` means the
session activity behind the claim is tool-verified — never say a business
capability is "verified"**, because the business-level reading is always the
classifier's judgment. `← claimed` means not even that much, and
`← provisional (1 session)` means a single session backs the whole row.
`excluded` counts learning/personal/unclassified work that earned no credit.

**"Why isn't this session classified?"** — `sl.js session <sid>` for the state,
`sl.js status` for the scheduler. Classification fires on a 60s idle tick after
`idle_minutes` (default 10) of quiet, or on SessionEnd. A session with zero
completed turns is never eligible. Three consecutive auth errors pause the
queue; `sl.js egress` shows them.

**"Is anything being captured?"** — `sl.js status`. For a clone install every
hook entry must be present in `~/.claude/settings.json`; if the checkout was
moved, renamed or re-cloned the embedded path is stale and `cli.js install`
repoints it. A plugin install has no entries there at all and should not get
any — Claude Code loads `hooks/hooks.json` from the plugin directly, and adding
settings.json entries too would capture every event twice. `cli.js doctor`
distinguishes the two.

**Sessions classified `unknown` at confidence 0.25** are the heuristic
fallback: the local `claude` CLI was unreachable, so nothing was really
classified and no capability credit was earned. Run `cli.js doctor` — it is
usually a `claude` login. The scheduler upgrades stored heuristic
classifications by itself once the classifier answers again.

## Rules

- **Never hand-edit `~/.claude/settings.json`.** It is shared and live —
  third-party hooks depend on it. Only `cli.js install` / `uninstall` may touch
  it.
- **Prompt text, digests and assistant excerpts stay on this machine.** They
  are readable here, but never put them in a file that leaves the machine, a
  commit, or an upload. Team uploads are content-stripped by construction and
  that is not configurable.
- `classify` spends real money. Ask before running it in bulk.
- Corrections (labels, renames, merges) always win over derived data —
  recompute never overwrites them.
