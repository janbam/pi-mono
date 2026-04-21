# pi-mono (fork)

This is a fork of `badlogic/pi-mono`.

**NEVER PR to upstream (`badlogic/pi-mono`)!**

## Branch Layout

| Branch | Purpose |
|--------|---------|
| `main` | Our fork's working branch (default) — all work targets here |
| `upstream` | Tracks upstream's latest release-tagged commit |

## Workflow

1. Create short-lived feature/fix branches from `main`
2. Do work on the branch, commit, push to origin
3. `gh pr create --base main` (targets `yannbam/pi-mono`)
4. `gh pr merge --merge` (merge on GitHub)
5. `git checkout main && git pull origin main` (pull merge commit locally)
6. Delete the feature branch (`git branch -d <branch>`)

## Maintaining the `upstream` branch

The `upstream` branch tracks upstream's latest release. Update it when a new version is tagged:

```bash
git fetch upstream --tags
git checkout upstream
git merge --ff-only <latest-release-tag>   # e.g. v0.67.68
git push origin upstream
git checkout main
```

To find the latest release tag: `git tag --sort=-v:refname | head -5`

## Syncing upstream into main

Only when janbam says so:

```bash
# Remove auto-generated file first to avoid merge conflicts
rm packages/ai/src/models.generated.ts

git checkout main
git merge upstream
# resolve any conflicts
git push origin main
```
