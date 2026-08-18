# Why the aggregation model looks the way it does

A strategic/business-level note on how statusline turns raw Claude Code
sessions into claims about professional experience — what it costs, what
scales, and which decisions are reversible. Written 2026-08-15, after the
Task 3 classification evaluation and the Task 4 aggregation foundation.

For implementation detail see `CLAUDE.md`; for open decisions see
`FOLLOWUPS.md`.

---

## The core bet

**The expensive, fallible judgment happens exactly once per session. Every
layer above it is deterministic math over stored facts.**

1. Hooks observe each session and produce a compact factual record: what was
   asked, which directory and repository it happened in, that repository's
   remote URL, which tools ran, which file types were actually *edited*
   (versus merely read). No file contents, no tool outputs.
2. **One LLM call per session** reads a digest of that record and answers the
   judgment questions — is this professional work, for whom, how deep, which
   technologies. Both the model's raw answer and the derived version are
   stored.
3. Everything above it — projects, engagements, practitioner experience,
   organization rollups — is **pure computation with zero LLM involvement**,
   recomputed from stored facts whenever anything changes.

### Why this matters commercially

Almost every mistake is reversible. Improve the grouping rules, rename a
technology, tighten what counts as "verified", change how experience is
counted — all history re-derives instantly and for free.

This is not theoretical; it has been exercised twice in production:

- the evidence-rule fixes (read-only file access no longer corroborates
  hands-on work; technology matching became exact) retroactively corrected
  every stored session;
- the shared vocabulary tables are distributed from the server and applied by
  every watcher on its next heartbeat, correcting all history with **zero**
  new LLM calls.

**The only unrecoverable mistake is failing to capture a raw fact in the first
place.** That is why repository remote URLs were added to capture *before*
team rollout rather than after — a fact not recorded is gone for every past
session.

---

## How sessions collapse upward

### Sessions → projects — automatic, mechanical, conservative

Sessions group by repository identity: the same repository (including separate
worktree checkouts of it) is one project; a directory inside a known
repository is absorbed into it; sessions run from generic home directories
become flagged "miscellaneous" items that are never presented or counted as
projects.

This runs continuously and needs no administration. It is deliberately
conservative: it never guesses, so its residual errors are *splits* (two
checkouts of one repository on different machines with different paths), never
contaminating *merges*. A split understates experience; a merge would
manufacture false claims. We chose the direction that fails safe.

### Projects → engagements — human-declared, optional, retroactive

A person declares "this repository path and this remote URL are the *Statusline*
engagement, internal work". Everything matching folds under that business name
— existing history and future machines included.

Business identity is deliberately *not* algorithmic: deciding what constitutes
an engagement, and what to call it in front of a customer, is a judgment we do
not want inferred. Cost is one command per engagement, whenever convenient,
and it can be done long after the work happened.

### Machines → practitioners — same pattern

Unmapped machines appear automatically under a provisional name, so the system
is useful from the first upload with no setup. Mapping a machine to a person is
one command, and all of that person's history re-attributes immediately.

### Projects → experience — the anti-inflation layer

This is where the business requirement is enforced in code, not convention.
Experience is counted in **distinct bodies of work, never activity volume**:

- one hundred sessions in one project remain **one project**;
- discussing a technology fifty times never raises its evidence above what a
  single session actually proved;
- tool-verified hands-on work stays permanently distinguishable from an
  unverified classifier claim;
- learning and personal work are counted separately and **never** accrue
  capability experience (the user's own label always wins);
- all miscellaneous catch-all work combined earns at most one flagged credit;
- two people on one engagement is **one** organization engagement, not two.

Every one of these is pinned by automated tests. They are the properties that
make an eventual public claim defensible.

---

## Cost

The only per-session cost is the single classification call — roughly
**four to five cents of inference** (measured: 78 calls for $3.16 during the
evaluation).

It runs **on each practitioner's own machine through their own Claude login**.
There is no central inference bill, and inference capacity scales with
headcount by definition. Resumed, compacted and forked sessions typically
inherit a recent classification instead of spending a call; a session is only
re-examined after meaningful new activity.

Aggregation, re-scoring all history, vocabulary changes, grouping
improvements, engagement declarations, practitioner re-attribution: **free,
forever**.

---

## Scalability — the honest answer

**Per machine:** trivial at any realistic personal volume. Everything is small
files and in-memory computation.

**Team-side:** the current implementation recomputes all projects and
experience from all uploaded sessions whenever data changes, storing the result
in fast read models that the UI and API serve directly. This is the right trade
at this stage — it is exactly what makes every improvement retroactive — and it
is comfortable into the **low thousands of sessions**, i.e. a small team for
many months.

**The current ceiling is 5,000 sessions per recompute.** A ten-person team at
moderate usage would approach that within a few months.

That ceiling is planned-for, not accidental. Because clients only ever ship raw
sessions and *everything derived is computed server-side*, the fix — windowing,
incremental recompute, or rolling older sessions into permanent project-level
facts — can be introduced **without touching a single client and without losing
history**. The storage schema was deliberately designed before collection
scaled up (queryable capability fields, nested structures that support
"who has verified experience with X" queries) precisely so growth does not force
a painful data migration later.

---

## Is it safe to collect aggressively?

Yes, with two eyes-open caveats.

**1. Capture is the only irreversible layer.** What is recorded per session
suits the business model (repository identity, remote URL, tool evidence,
prompts) and is privacy-conservative by construction (no file contents, no tool
outputs, secrets masked). Anything we later wish we had captured is gone for
past sessions. If a fact will matter to future profiles, it must be added to
capture *now*.

**2. Trust boundaries are per-tier, not global.** The evaluation established
that the classifier's judgments are reliable for internal use, but only the
**tool-verified** tier is strong enough to back external claims. The data model
carries that distinction all the way up — every capability records how many
distinct projects verified it, whether any contributing classification was a
fallback, and the minimum confidence involved — so a future public layer can
filter to what is defensible without recomputing anything. Holding that line is
a product decision, and it has to hold.

Everything else — grouping imperfections, naming, engagement definitions, even
the scaling ceiling — is correctable after the fact at zero inference cost.
**That recoverability is what makes aggressive collection safe.**

---

## Getting onto a machine — distribution

The client is **open source and public** (`Instafill/statusline`, MIT); the
cloud app that receives uploads is not. That split is what makes distribution
work: a tool that reads every session on a machine has to be inspectable by the
person running it, and an install path that needs private-repo access is not an
install path at all — it is a favour granted per person.

**The vehicle is a Claude Code plugin.** Everyone who installs this already
runs Claude Code, so the plugin system is our audience's package manager, and
it is the only option that *deletes* work rather than adding it: plugin hooks
declare themselves in `hooks/hooks.json` against `${CLAUDE_PLUGIN_ROOT}`, so
Claude Code — not our installer — owns registration, and the
"moving the checkout breaks capture" footgun disappears with it.

Three channels, all of them ours, none requiring anyone's permission to
publish:

1. **The public repo is the marketplace.** `/plugin marketplace add
   Instafill/statusline` clones over plain HTTPS — no GitHub account, no `gh`
   CLI, no auth — then `/plugin install statusline@statusline`. There is no
   registry to be listed in and no review to pass: the marketplace file lives
   in our repo and the user's client fetches it directly.
2. **The deployment serves its own marketplace.** Each tenant app exposes
   `GET /marketplace.json` pinned to the client version that deployment expects,
   so `/plugin marketplace add https://<tenant>/marketplace.json` installs
   exactly the client its server was built against, and a redeploy is how an
   update ships. The dashboard already mints the enroll code on the same page.
3. **Git clone remains the floor.** `git clone` + `install.ps1`/`install.sh`
   works with no plugin system at all: the installer writes the hook entries
   itself, and a bare directory under `~/.claude/skills/` is a complete skill
   install. Contributors and air-gapped setups live here.

Two things the plugin channel does not solve, both deliberate:

- **Node is still a requirement.** The biggest remaining failure for a
  non-developer is "node is not on PATH". A single-executable build (Node SEA)
  or a signed `.pkg`/MSI that bundles the runtime turns the install into a
  double-click — deferred until a customer needs it, because signing and Apple
  notarization cost ongoing certificate and CI work.
- **The watcher is a daemon, and a plugin cannot start one at install time.**
  Enrollment and `cli.js autostart` cover it (login-time scheduled task /
  launchd agent), with autostart resolving the agent root indirectly so a
  plugin update — which lands in a new versioned directory — does not strand
  the task.

What we are explicitly **not** doing: publishing to public npm or a Homebrew
tap (a global npm install is a poor fit for a background service that must
survive updates), and per-tenant forks of the client (the client is identical
everywhere; only the endpoint and the enroll code differ).

---

## Privacy and egress, in one paragraph

A local install has exactly two network paths: the classifier call through the
user's own Claude CLI, and — **only when team upload is explicitly enabled** —
session documents and heartbeats to the team endpoint. Since 2026-08-17 those
session documents are **always content-stripped**: prompt text, assistant
excerpts, digest text and command text never leave the machine on the upload
path — only classification results, tool evidence, counts, paths and git
identity do, which is everything the aggregation layer ever reads. The strip
is enforced on both ends (the uploader before sending, the ingest endpoint
again as the trust boundary), so it is a property of the system, not a
setting. The one caveat worth stating plainly: the classifier call itself
carries a digest *containing* prompts to the model through the user's own
login — that inference is the product, it is per-user, and every call is
logged. Every attempt on either path is recorded in a local egress log the
user can inspect. An install with upload disabled loads none of that code.
There is no telemetry. The watcher never connects to a database; all team
storage sits behind the team app's authenticated API.
