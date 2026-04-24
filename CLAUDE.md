# pi-mono (fork)

This is a fork of `badlogic/pi-mono`.

**NEVER PR to upstream (`badlogic/pi-mono`)!**

## Branch Layout

| Branch | Purpose |
|--------|---------|
| `main` | Our fork's working branch (default) — all work targets here |
| `upstream-release` | Tracks upstream's latest release-tagged commit (read-only mirror) |

## Workflow

1. Create short-lived feature/fix branches from `main`
2. Do work on the branch, commit, push to origin
3. `gh pr create --base main` (targets `yannbam/pi-mono`)
4. `gh pr merge --merge` (merge on GitHub)
5. `git checkout main && git pull origin main` (pull merge commit locally)
6. Delete the feature branch (`git branch -d <branch>`)

## Maintaining the `upstream-release` branch

The `upstream-release` branch is a read-only mirror of upstream's latest release tag. Recreate it when a new version is tagged:

```bash
git fetch upstream --tags
LATEST=$(git tag --sort=-v:refname | head -1)
git branch -f upstream-release "$LATEST"
git push origin upstream-release --force-with-lease
git checkout main
```

To find the latest release tag: `git tag --sort=-v:refname | head -5`

## Syncing upstream-release into main

Only when janbam says so.

**Abort and ask for clarification if `main` has uncommitted changes.**

```bash
git checkout main
# If the working tree is dirty, STOP and ask janbam before proceeding.

# Discard any local build artifacts (auto-generated)
rm -f packages/ai/src/models.generated.ts

git merge upstream-release
# resolve any conflicts

# Update dependencies and rebuild
npm install
npm run build
npm run check

# Address any build errors
# Ask the user to smoke test the new build

# When everything is good, commit and push
git push origin main
```
