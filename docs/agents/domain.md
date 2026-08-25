# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one `CONTEXT.md` and one `docs/adr/` at the root.

## Before exploring, read these

- **`CLAUDE.md`** at the repo root - the hard rules, the two install shapes, and the gotchas. Read it first, it is the one document that is always current.
- **`ARCHITECTURE.md`** - why the aggregation model is shaped the way it is, what it costs, where it stops scaling. Read it before changing what gets captured or how experience is counted.
- **`CONTEXT.md`** at the repo root - the glossary.
- **`docs/adr/`** - read ADRs that touch the area you are about to work in.

If any of these files do not exist, **proceed silently**. Do not flag their absence, do not suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CLAUDE.md
├── ARCHITECTURE.md
├── CONTEXT.md
├── docs/
│   ├── agents/
│   └── adr/
│       ├── 0001-....md
│       └── 0002-....md
├── src/
├── hooks/
├── skills/statusline/
├── public/
└── test/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

This codebase already has a settled vocabulary that predates the glossary - session, fold, digest, classification, evidence, canonical technology, business capability, project grouping, experience, engagement, singleton, membership basis, egress. `CLAUDE.md` is where those terms are used correctly. Match it rather than inventing a parallel naming.

If the concept you need is not in the glossary yet, that is a signal - either you are inventing language the project does not use (reconsider), or there is a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, or one of the hard rules in `CLAUDE.md`, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced sessions), but worth reopening because..._
