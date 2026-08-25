# statusline

A local-only observer of Claude Code sessions: it captures what happened, judges
each session once, and aggregates the result into claims about professional
experience.

This glossary pins only the terms that have actually been argued out. It is not a
map of the codebase. `CLAUDE.md` holds the rules and `ARCHITECTURE.md` the
reasoning.

## Language

### Capability

**Capability**:
Either of the two axes experience is counted along, technology or business. The
bare word is never used on its own, in code, docs, UI copy or an issue title,
because the two axes carry different evidence and different confidence. Always
say which one.
_Avoid_: capability (unqualified), skill, competency

**Technology capability**:
A canonical technology a practitioner has evidence for, counted in distinct
projects. Carries `verified_projects`, because a tool ran and left a trace.
Surfaced as `capabilities[]` on the experience doc, which is a legacy field name
for this axis alone and never for both.
_Avoid_: capability, tech, stack item

**Business capability**:
A pick from the closed, versioned catalog saying what the work solved, counted in
distinct projects. Carries `grounded_projects`, never `verified_*`: a tool trace
can prove a technology was used, but never that the business reading of the work
was right.
_Avoid_: capability, business skill, domain capability

**Grounded**:
A business capability whose claim sat on at least one session with tool-verified
technology activity. The strongest tier a business capability can reach.
_Avoid_: verified (reserved for technology capabilities), confirmed, proven

**Verified**:
A technology capability corroborated by tool evidence, where a read-only file
access never counts. Applies to technology capabilities only.
_Avoid_: confirmed, proven, validated
