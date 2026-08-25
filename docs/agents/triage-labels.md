# Triage labels

The skills speak in canonical triage roles. This file maps those roles onto what actually exists in our trackers.

Most roles are a **status**, not a label. Only two roles needed a real label, because status alone could not express them.

## Linear (default surface), team `Instafill`, project `Statusline`

### State roles

| Role in mattpocock/skills | In our Linear                     | Meaning                                  |
| ------------------------- | --------------------------------- | ---------------------------------------- |
| `needs-triage`            | status `Backlog`                  | Maintainer needs to evaluate this issue  |
| `needs-info`              | status `Backlog` + label `Needs info` | Waiting on reporter for more information |
| `ready-for-agent`         | status `Todo` + label `Ready for agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human`         | status `Todo`                     | Requires human implementation            |
| `wontfix`                 | status `Canceled`                 | Will not be actioned                     |

`Todo` without `Ready for agent` means a human takes it. An AFK agent picks up only `Todo` + `Ready for agent`.

`In Progress`, `Testing`, `Done`, and `Duplicate` have no triage role, they are ordinary workflow states.

### Category roles

| Role in mattpocock/skills | In our Linear | Meaning                    |
| ------------------------- | ------------- | -------------------------- |
| `bug`                     | label `Bug`   | Something is broken        |
| `enhancement`             | label `Feature` | New capability           |
| `enhancement`             | label `Improvement` | A change to something that already works |

Other labels exist for routing, not triage: `Frontend`, `Backend`, `Autofill`, `Fine-tuning`, `Research`, `Long list`, `tested on DEV`, `MetLife`. Most of them belong to the other repos on this team. Apply one only when it obviously fits, never invent new ones without asking.

Label naming style in this workspace: capitalised first word, spaces rather than hyphens. Follow it if a new label is ever added.

Labels are set through `save_issue`, which replaces the whole `labels` array, so send the full list, not just the new label.

## Local markdown surface (`.scratch/`)

There are no statuses to lean on beyond the file's own frontmatter, so all five roles stay plain labels in the `labels` list: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

Frontmatter `status` stays the workflow state (`backlog`, `todo`, `in-progress`, `done`, `canceled`, `duplicate`) and does not double as a triage role.
