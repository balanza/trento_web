# Prepare-release: add from-main mode

**Status:** Approved (pending spec review)
**Date:** 2026-06-10
**Affects:** `.github/workflows/prepare-release.yaml`
**Related:** [2026-06-09-prepare-release-idempotency-design.md](./2026-06-09-prepare-release-idempotency-design.md)

## Problem

`prepare-release.yaml` only automates one of the two release shapes the project actually does:

- **Hotfix from release** (current): cherry-pick `milestone:NEXT` PRs from main onto release, then bump VERSION on release.
- **Full from main** (manual today): bump VERSION directly on main; release.yaml's cross-merge handles propagation to release.

The from-main path works mechanically (`release.yaml` triggers on VERSION pushes to either branch), but has no orchestration. It's easy to forget the prior hotfix happened at all when computing NEXT or checking in-flight state, and easy to mis-target the VERSION bump.

## Goal

Extend `prepare-release.yaml` with a `source` input. When `source: main`, the workflow:

1. Computes NEXT from main's VERSION.
2. Verifies no other from-main release is in flight.
3. Opens a VERSION-bump PR against main using the same idempotent open-or-skip logic as today.

When `source: release`, behavior is unchanged from today (idempotent cherry-pick patch flow).

## Intended end-to-end scenario

Walking through the user's concrete example to anchor the design:

| Step | Action | main state | release state |
|---|---|---|---|
| t0 | Aligned start | 3.1.0 | 3.1.0 |
| t1 | Merge PR1, PR2, PR3, PR4, PR5 into main | 3.1.0 + PR1-5 | 3.1.0 |
| t2 | Add `milestone:3.1.1` to PR1 and PR3 | (no commit change) | (no change) |
| t3 | Dispatch prepare-release `source=release, version_bump=patch` | (no change) | (no change) |
| t4 | Workflow opens 2 porting PRs (PR1, PR3) + version-trigger PR; user merges all | (no change) | 3.1.1 with PR1, PR3 cherry-picked |
| t5 | release.yaml fires on VERSION push to release; tags v3.1.1, cross-merges release into main with `-X ours` (main keeps VERSION=3.1.0) | 3.1.0 (post-merge) | 3.1.1 |
| t6 | Dispatch prepare-release `source=main, version_bump=minor` | (no change) | (no change) |
| t7 | Workflow opens version-trigger PR against main bumping to 3.2.0; user merges | 3.2.0 | (no change) |
| t8 | release.yaml fires on VERSION push to main; tags v3.2.0, cross-merges main into release with `-X theirs` (release picks up main's content) | 3.2.0 | 3.2.0 |

**Final state:** both branches at 3.2.0. The 3.2.0 GitHub release notes mention PR1, PR2, PR3, PR4, PR5 — release-drafter computes since the previous tag reachable from main, which is v3.1.0 (v3.1.1 is on the sibling release branch, not in main's ancestry until the cross-merge at t8). The 3.1.1 release notes remain published separately on GitHub Releases.

This is the intended behavior — the user explicitly wants the from-main 3.2.0 changelog to include all PRs since 3.1.0, including the ones that were also cherry-picked into 3.1.1. The 3.1.1 release stands as a separate published release; it's not specially considered by the from-main flow.

## Non-goals

- **Hotfix-PR exclusion from from-main release notes.** Earlier design considered auto-applying `released-as-hotfix` to cherry-picked PRs. Explicitly dropped: the user wants PR1/PR3 to appear in both 3.1.1 *and* 3.2.0 notes. (The `released-as-hotfix` label remains available in `release_drafter_main.yaml`'s `exclude-labels` for ad-hoc manual use if ever desired.)
- **CHANGELOG.md backport** from release to main. main's `CHANGELOG.md` will not have a 3.1.1 entry; after the cross-merge at t8, release's `CHANGELOG.md` won't either. GitHub Releases remains the canonical changelog.
- **Hotfix-only-commit audit** (warn if release has commits whose patch-id isn't reachable from main).
- **CI gating** on the VERSION-bump PR. `ci.yaml` has `paths-ignore: [VERSION]`. Workaround: include any non-VERSION file change in the PR.
- **Auto-detecting source from `version_bump`** (patch → release, minor/major → main). Explicit is safer; auto-detect can be a later iteration.

## Design

### New input

```yaml
inputs:
  version_bump: { ...unchanged... }
  source:
    description: "Where to compose the release from"
    required: true
    type: choice
    default: release          # preserves backward compat for existing dispatchers
    options:
      - release               # cherry-pick patch flow (current behavior)
      - main                  # from-main full flow (new)
```

### Control flow

One `prepare` job. Steps gain `if:` guards where they're mode-specific:

| Step | When |
|---|---|
| Check out `${{ inputs.source }}` (fetch-depth: 0) | always |
| Configure git author | always |
| Compute current + NEXT version (reads VERSION on `$SOURCE`) | always |
| Ensure no different release is already in flight | always (refined filter, see below) |
| Fetch merged PRs for `milestone:${NEXT}` from main | `if: inputs.source == 'release'` |
| Open porting PRs against `release` (existing idempotent loop) | `if: inputs.source == 'release'` |
| Open the version-trigger PR against `${{ inputs.source }}` (existing idempotent logic, parameterized) | always |

### "In-flight" guard (refined for both modes)

Replace the current "any open PR against release except port/NEXT/* and version/NEXT" with a guard scoped to `$SOURCE` that only catches **release-coordinating PRs for other versions**:

```bash
open=$(gh pr list --base "$SOURCE" --state open --json number,title,headRefName)
others=$(echo "$open" | jq --arg ver "${NEXT}" '
  [.[] | select(
    ((.headRefName | startswith("port/")) and ((.headRefName | startswith("port/\($ver)/")) | not))
    or ((.headRefName | startswith("version/")) and (.headRefName != "version/\($ver)"))
  )]
')
count=$(echo "$others" | jq 'length')
if [ "$count" -gt 0 ]; then
  echo "::error::Found ${count} open release-coordinating PR(s) for a different version. Resolve them before starting a new ${NEXT} release."
  echo "$others" | jq -r '.[] | "  #\(.number) \(.title) (head: \(.headRefName))"'
  exit 1
fi
```

Two consequences vs. today's logic:

1. **For source=release**, this is *more permissive*: it no longer fails on unrelated open PRs against release (e.g., experimental branches). It still fails on `port/X/*` or `version/X` for X≠NEXT. Acceptable — that matches what the guard is actually trying to prevent.
2. **For source=main**, it correctly ignores ordinary feature PRs (which target main) and only flags `version/X` PRs for X≠NEXT — i.e., another from-main release in flight.

### Parameterized version-trigger step

The existing version-trigger step is unchanged in structure (probe → orphan-cleanup → push + create) but switches three hardcoded references from `release` to `${SOURCE}`:

- `gh pr list --head "$branch" --base release --state all ...` → `--base "$SOURCE"`
- `git checkout release` → `git checkout "$SOURCE"`
- `gh pr create --base release ...` → `--base "$SOURCE"`

The branch name (`version/${NEXT}`), title (`Trigger release ${NEXT}`), and `skip-release-notes` label are unchanged. `release.yaml` doesn't distinguish — it just watches VERSION changes on either branch.

The PR body differs between modes:

- **source=release** (unchanged): *Bumps the VERSION file to **${NEXT}**.* *Merging this PR triggers the release workflow. Do not merge until all porting PRs against `release` have been merged — the* Validate Release Trigger PR *check enforces this.*
- **source=main**: *Bumps the VERSION file to **${NEXT}** on `main`.* *Merging this PR triggers the release workflow from main HEAD. release.yaml will tag ${NEXT} and cross-merge main into release automatically. Note: there is no automated validation on PRs into `main` — review carefully.*

## Tests

All dispatched against `balanza/trento_web` (origin), workflow ref set to the feature branch:

1. **Backward compat (source=release)** — clean state, `source=release, version_bump=patch`. Expected: identical to today's behavior — porting PR(s) for any `milestone:NEXT` PRs + version-trigger PR against release.
2. **From-main basic** — clean state, `source=main, version_bump=minor`. Expected: no porting steps run; version-trigger PR opens against main; VERSION bumped on main via the PR.
3. **From-main idempotent re-run** — re-run test 2 without cleanup. Expected: version-trigger probe says "already open — nothing to do".
4. **In-flight guard, main mode** — stub `version/X` PR open against main (X≠NEXT). Dispatch `source=main` with a different bump. Expected: fails with "Found 1 open release-coordinating PR(s) for a different version".
5. *(Optional)* **In-flight guard, release mode (regression)** — open a non-port, non-version PR against release; dispatch `source=release`. Expected: guard passes (new refined behavior is more permissive than before).

Pass criteria: each expected log line appears; final repo state matches.

## Out-of-scope mitigations the human still owns

- **CHANGELOG.md backport**: before triggering a from-main release, optionally open a small PR adding the prior hotfix section to main's `CHANGELOG.md`. Otherwise the markdown file will skip from 3.1.0 → 3.2.0.
- **Hotfix-only-commit audit**: `git log main..release --no-merges` reveals commits unique to release. The cross-merge from main into release (with `-X theirs`) will silently overwrite their content. Backport anything you want to keep before triggering from-main.
- **CI on the VERSION-bump PR**: include any non-VERSION file change to defeat `paths-ignore: [VERSION]`.
- **Two simultaneous from-main releases**: the `concurrency: prepare-release` group prevents two workflow runs at once, and the in-flight guard prevents starting a release while another is half-merged. Don't bypass either.
