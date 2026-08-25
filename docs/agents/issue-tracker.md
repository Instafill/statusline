# Issue tracker

Two surfaces live side by side. Pick one per effort, never mix them inside a single effort.

| Surface                          | When                                                        |
| -------------------------------- | ----------------------------------------------------------- |
| **Linear**, team `Instafill`, project `Statusline` | Default. Everything, unless the user says otherwise.        |
| **Local markdown**, `.scratch/`  | Only when the user explicitly asks for a local, scratch, or not-in-Linear ticket. |

If an effort already has a home (a `.scratch/<feature>/map.md`, or a Linear issue the conversation is about), stay there. Do not migrate an in-flight effort between surfaces.

GitHub pull requests are not a request surface here. Do not pull PRs into the triage queue.

Writing to Linear is an externally visible action. Confirm with the user before the first `save_issue` of a session, then proceed without re-asking for follow-up edits to the same effort.

## Surface A: Linear (default)

Workspace `instafill`, team **Instafill** (key `ID`), project **Statusline**.

Tools are the Linear MCP tools.

- **Create an issue**: `save_issue` with `team: "Instafill"` and `project: "Statusline"`. Everything from this repo belongs to that project, so set it every time - it is what says which repo the issue is about.
- **Read an issue**: `get_issue`. Comments via `list_comments`.
- **List issues**: `list_issues` filtered by team, project, status, or label.
- **Comment**: `save_comment`.
- **Apply labels**: `save_issue` replaces the whole `labels` array, so send the full list, not just the new label.
- **Close**: `save_issue` with `state: "Done"`, or `"Canceled"` for rejected work, and a closing comment with the outcome.

Statuses: `Backlog`, `Todo`, `In Progress`, `Testing`, `Done`, `Canceled`, `Duplicate`.

Triage roles map onto these statuses and labels. See `triage-labels.md`.

This repo is one of five that share the `Instafill` Linear team (`instafill-ai`, `processing-api-instafill`, `admin_v2`, `api.instafill.ai`, `statusline`). The `Statusline` project is the separator, so an issue that lands without it reads as somebody else's repo.

Other projects on this team (`General Agent flow`, `MCP`, `Inlight Psychiatry Letter`, and the closed ones) belong to the other repos. Do not file statusline work into them.

### Issues that belong to an epic

An epic is a large parent issue that several PR-sized issues deliver between them. A child of one carries **both** links, never only one:

- `parentId` set to the epic, which makes it a sub-issue.
- `relatedTo` including the epic, which is what puts it in the relations list on the epic itself.

`parentId` alone looks right on the child and leaves the child absent from the view people read on the epic. Before creating a child, read an existing sibling and match its relations, because a new ticket that carries fewer is the one that goes unnoticed.

Relate the child to any narrower standing ticket it delivers as well.

Inherit the siblings' `project`, `labels` and `priority` too, unless there is a reason to differ. A sub-issue created with none of them drops off every board its siblings appear on.

### Moving a ticket through its statuses

The agent owns these transitions and makes them without being asked:

| Move to | When |
| -- | -- |
| `In Progress` | Work on the ticket starts. |
| `Testing` | Implementation is done and the verification phase begins. |
| `Done` | The PR is merged. |

A ticket created ready to work on is created in `Todo`, not `Backlog`. `Backlog` means it still needs triage.

### After a PR merges

1. Attach the PR to the child issue **and** to the epic, with `save_issue` and `links`. That field is append-only, so existing attachments survive.
2. Comment on the child with what shipped, the decisions worth remembering, and every divergence from what the ticket asked for. A scope change nobody wrote down is a scope change nobody can review.
3. Move the ticket to `Done`.

Never edit the body of an issue. Corrections and additions go in comments. The single exception is a body written moments earlier in the same conversation at the user's own direction.

## Surface B: local markdown (`.scratch/`, gitignored)

Each effort gets one directory:

```text
.scratch/<feature>/
├── map.md
└── issues/
    ├── 001-first-ticket.md
    └── 002-second-ticket.md
```

Issue files use YAML frontmatter with `id`, `title`, `status`, `type`, `labels`, `blocked_by`, and `assignee`.

Allowed statuses are `backlog`, `todo`, `in-progress`, `done`, `canceled`, and `duplicate`.

- **Create an issue**: add the next numbered markdown file under `.scratch/<feature>/issues/`.
- **Read an issue**: open its markdown file. Its body and `## Log` section are the complete record.
- **List issues**: inspect frontmatter under the relevant `issues/` directory.
- **Comment**: append a dated entry under `## Log`.
- **Apply or remove labels**: edit the frontmatter `labels` list.
- **Close**: set `status: done`, or `status: canceled` for rejected work, and record the outcome under `## Result`.

## When a skill says "publish to the issue tracker"

Create a Linear issue in team `Instafill`, project `Statusline`. On the local surface, create the next numbered markdown file in the effort's `issues/` directory.

## When a skill says "fetch the relevant ticket"

Read the Linear issue and its comments. On the local surface, read the matching issue file and its `## Log` section.

## Wayfinding operations

Used by `/wayfinder`.

On Linear: the map is a Linear document or the parent issue description, child tickets are sub-issues, and blocking uses Linear's blocked-by relations.

On the local surface: the map is `map.md`, tickets are files under `issues/`.

- **Map**: holds Destination, Notes, Decisions so far, Fog, and the ordered ticket list.
- **Child ticket**: one ticket with `type` set to `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: a ticket is unblocked when every listed blocker is `Done`/`done` or `Canceled`/`canceled`.
- **Frontier query**: first ordered ticket that is `Todo`/`todo`, has no unfinished blocker, and has no assignee.
- **Claim**: set the status to `In Progress`/`in-progress` and fill the assignee.
- **Resolve**: write the result, close the ticket, then add the decision to the map.
