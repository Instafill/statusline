---
name: release
description: Cut a statusline release - version bump, tag, GitHub release notes.
disable-model-invocation: true
---

# Release

Cuts a statusline release from a clean `main` with everything that ships already merged.

**A release distributes nothing.** Claude Code reads the plugin version from
`.claude-plugin/marketplace.json` on `main`, never from a tag or a GitHub Release, so users
reach the new code the moment the bump merges. The tag and the release exist for people
reading the repository. Say so plainly if anyone treats the release as the shipping step.

## 1. Gate

`bun run check` (or the `npm run` equivalent): format check, lint, types, tests. A red gate
ends the release. Fix the cause on its own, then start again from here.

`git status -sb` must be clean and `main` in sync with `origin/main`. A dirty tree holds work
that is neither in the release nor deliberately out of it.

## 2. Bump

`bun run bump <patch|minor|major>`. Pass the kind every time: with no argument the script
opens a raw-mode arrow-key picker that needs a TTY the agent does not have.

Choose the kind from what landed since the last tag.

Commit the changed manifests alone, subject exactly `Version bump`, and push. Done when
`git show --stat HEAD` lists manifests and nothing else.

## 3. Tag

```
git log --oneline -1
git ls-remote --tags origin 'v<version>'
```

Name the commit the tag lands on and confirm the tag is free, then:

```
git tag -a v<version> -m 'v<version>'
git push origin v<version>
```

Done when `git show --no-patch --format='%H %d' v<version>` puts the tag on the bump commit.

## 4. Notes

Read what shipped from the commits, then from the code behind any subject that does not say
what changed on its own:

```
git log --oneline <previous tag>..v<version> --no-merges
```

Notes that restate commit subjects tell a reader nothing the log does not.

**Notes describe the shipped state.** A fix that landed is part of the change, so write the
fix and the mechanism behind it, not the moment it was noticed or who noticed it.

Structure:

- **Title** `v<version> - <short descriptor>`, the descriptor naming the one thing the
  release is about.
- **Opening paragraph**, two sentences: the symptom a user would have noticed, and what this
  release does about it.
- **`## Fixes`**, a bold lead-in per fix followed by why it happened. The mechanism is the
  part worth writing down.
- Further sections the release earns, `## Tooling` and the like. Omit the empty ones.
- **`## Upgrading`** whenever anything under `src/` changed. The watcher holds its config and
  its resolved classifier CLI for the life of the process, so updating the plugin changes
  nothing until it restarts.

Write the body to a scratch file and pass it as `--notes-file`.

## 5. Draft, then publish

```
gh release create v<version> --title '<title>' --draft --notes-file <path>
```

Show the notes and wait for the user. The draft URL comes back as `untagged-…`, which is
normal: GitHub binds a draft to its tag on publish.

Publish on their word:

```
gh release edit v<version> --draft=false --latest
```

Done when `gh release list` marks the new version `Latest`.

## 6. Verify the install, not the clone

Ask the user to update the plugin in Claude Code (`/plugin`, then `/reload-plugins`) and say
when it is done. Then repoint autostart and restart the watcher so the new code is the
running code:

```
cd ~/.claude/plugins/cache/statusline/statusline/<version>
node src/cli.js autostart
```

Then read `~/.statusline/watcher.lock`, a JSON object carrying the running `pid`, and kill
that pid. Where autostart is registered, launchd brings the watcher back on the new root by
itself, otherwise run `node src/cli.js start`. Poll `http://127.0.0.1:45817/api/health` until
it answers with a new `pid`, then `node src/cli.js doctor`.

Done when doctor reports zero warnings and zero failures. `Agent location` naming the old
version means autostart still points at the previous copy, and `Classifier reach` saying the
watcher predates the check means the restart did not happen.
