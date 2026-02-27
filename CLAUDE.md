# ULTRACLAUDE - Fork Workflow

## Branch Structure

This fork uses a 3-branch strategy to cleanly separate upstream sync from our development work.

```
main (pristine upstream mirror)
  │
  └── sync from badlogic/pi-mono (git fetch upstream, git rebase upstream/main)
  │
janbam-main (our stable fork)
  │
  └── merge PRs from janbam-dev when tested
  │
janbam-dev (active development)
      └── feature branches, experiments, wip
```

## Branches

### `main`
- **Purpose:** Pristine mirror of upstream (badlogic/pi-mono)
- **Never commit to directly**
- **Never develop here**
- **Only action:** Pull upstream updates, then fast-forward our fork branches

### `janbam-main`
- **Purpose:** Our stable, production-ready fork
- **Receive merges from janbam-dev** when work is tested and stable
- **Never receive direct commits**
- **Can be reset to main** if we need to abandon our changes and sync fresh

### `janbam-dev`
- **Purpose:** Active development, experiments, WIP
- **Commit freely here**
- **Merge into janbam-main** via PR when ready
- **Can be messy, can be rebased**

## Workflow

### Pulling Upstream Updates

```bash
# Switch to main, ensure clean state
git checkout main
git status  # should be clean

# Fetch and rebase from upstream
git fetch upstream
git rebase upstream/main

# Push to our fork
git push origin main

# Now sync our dev branches
git checkout janbam-main
git merge main  # or rebase if we want clean history

git checkout janbam-dev
git merge main  # or rebase
```

### Daily Development

```bash
# Work on janbam-dev
git checkout janbam-dev
# ... hack hack hack ...
git add <files>
git commit -m "feat: my cool feature"
git push origin janbam-dev
```

### Promoting to Stable

```bash
# When janbam-dev is tested and ready
git checkout janbam-main
git merge janbam-dev
git push origin janbam-main
```

## Remotes

```bash
git remote -v
# origin  git@github.com:yannbam/pi-mono.git (fetch/push)  <- our fork
# upstream git@github.com:badlogic/pi-mono.git (fetch/push)  <- original repo
```

## Golden Rules

1. **NEVER** commit to `main`
2. **NEVER** push directly to `janbam-main` - always merge via PR from `janbam-dev`
3. **ALWAYS** rebase `main` from `upstream`, never merge
4. **ALWAYS** sync `janbam-main` and `janbam-dev` after upstream updates
