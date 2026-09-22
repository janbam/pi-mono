# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- Never stream the full `./test.sh` output into the conversation. Capture it in a unique `/tmp` log, preserve the suite's exit status, and print only compact failure and summary lines: `test_log=$(mktemp /tmp/pi-test.XXXXXX.log); ./test.sh >"$test_log" 2>&1; test_status=$?; rg -n 'FAIL|Failed Tests|Test Files|Tests|npm error' "$test_log"; printf 'Full log: %s\n' "$test_log"; exit "$test_status"`. Do not add context lines to this initial filter because dot-reporter lines can be enormous. Inspect only the relevant failure ranges in the retained log when more detail is needed instead of rerunning the suite.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.pi/skills/release.md](.pi/skills/release.md).

## User Override

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- NEVER use `git add -A` or `git add .` - these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session
- It is always fine to include `packages/ai/src/models.generated.ts` or `packages/ai/src/image-models.generated.ts` in a commit alongside the actual files you want to commit

### Forbidden Git Operations

These commands can destroy other agents' work:

- `git reset --hard` - destroys uncommitted changes
- `git checkout .` - destroys uncommitted changes
- `git clean -fd` - deletes untracked files
- `git stash` - stashes ALL changes including other agents' work
- `git add -A` / `git add .` - stages other agents' uncommitted work
- `git commit --no-verify` - bypasses required checks and is never allowed

### Safe Workflow

```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add packages/ai/src/providers/transform-messages.ts
git add packages/ai/CHANGELOG.md

# 3. Commit
git commit -m "fix(ai): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push

### User override

If the user instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.

# Additional Instructions for this Fork

## pi-mono (fork)

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
3. `gh pr create --base main` (targets `janbam/pi-mono`)
4. `gh pr merge --merge` (merge on GitHub)
5. `git checkout main && git pull origin main` (pull merge commit locally)
6. Delete the feature branch (`git branch -d <branch>`)

## Build After Code Changes

This fork overrides the general command rule that forbids `npm run build` unless explicitly requested.

After finishing any code change in this fork, run `npm run build` before the required `npm run check`. The build is part of the normal verification loop here because stale compiled artifacts can make the runnable `pi` disagree with the updated source.

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

## Updating this fork from `upstream-release`

Only update when instructed to do so.

> **Always refresh `upstream-release` first** (see previous section) before running the merge. The early-exit check below is only meaningful if `upstream-release` already points at the latest upstream tag. Check current upstream releases at <https://github.com/earendil-works/pi/releases> and compare against the tag on `upstream-release`.

Integrate upstream on a dedicated branch created from synchronized `main`; never create the upstream merge commit directly on `main`. The integration commit must retain the previous fork `main` as its first parent and the exact `upstream-release` tag as its second parent. Merge its PR with a merge commit—never squash or rebase it—so both histories remain explicit and reachable.

**Abort and ask for clarification if the worktree has uncommitted changes.**

```bash
git checkout main
git pull --ff-only origin main

# If the worktree is dirty, STOP and ask janbam before proceeding.

# Stop immediately when main already contains the refreshed upstream-release.
git merge-base --is-ancestor upstream-release main && echo "Already up to date — nothing to merge." && exit 0

# Replace vX.Y.Z with the tag mirrored by upstream-release.
git checkout -b chore/merge-upstream-vX.Y.Z

git merge --no-ff --no-commit upstream-release
# resolve any conflicts

# Keep the merged generated catalogs: the build regenerates them in place, and the
# generator reads the existing models.generated.ts as its rollback snapshot (deleting it breaks the build).

# Bump packages/pless to the merged lockstep version first: its version and both
# @earendil-works/* ranges must match the new workspace version, or npm installs a
# nested published pi-coding-agent copy and the pless tests fail on a missing subpath export.

# Update dependencies and rebuild
npm install
npm run build
npm run check

# Address any build errors
# Ask the user to smoke test the new build

# Preserve the upstream tag as the merge commit's second parent.
git commit -m "Merge upstream-release (vX.Y.Z) into main"
git push -u origin chore/merge-upstream-vX.Y.Z

# Open the PR against janbam/pi-mono main using a body file, then merge—not squash or rebase.
# Write the concise PR summary to /tmp/pi-upstream-pr-body.md first.
gh pr create --base main --head chore/merge-upstream-vX.Y.Z --body-file /tmp/pi-upstream-pr-body.md
gh pr merge --merge
git checkout main
git pull --ff-only origin main
git branch -d chore/merge-upstream-vX.Y.Z
```

When landing a PR or integrating an upstream release, always read `JANBAM_DOCS/FORK_MODS.md` and keep every fork divergence documented there.
