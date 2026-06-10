# Prepare-release: add from-main mode

**Status:** Approved (pending spec review)
**Date:** 2026-06-10
**Affects:** `.github/workflows/prepare-release.yaml`
**Related:** [2026-06-09-prepare-release-idempotency-design.md](./2026-06-09-prepare-release-idempotency-design.md)

## Problem

`prepare-release.yaml` only automates one of the two release shapes the project actually does:

- **Hotfix from release** (current): cherry-pick `milestone:NEXT` PRs from main onto release, then bump VERSION on release.
- **Full from main** (manual today): bump VERSION directly on main; release.yaml's cross-merge handles propagation to release.

The from-main path works mechanically (`release.yaml` triggers on VERSION pushes to either branch), but has no orchestration. The two pitfalls that bite are: (a) cherry-picked PRs from the prior hotfix re-appear in the from-main release notes as duplicates, and (b) it's easy to forget the prior hotfix happened at all when computing NEXT or checking in-flight state.

## Goal

Extend `prepare-release.yaml` with a `source` input. When `source: main`, the workflow:

1. Computes NEXT from main's VERSION.
2. Verifies no other from-main release is in flight.
3. Auto-labels PRs whose merge SHA was cherry-picked into release since the previous release tag with `released-as-hotfix`, so release-drafter excludes them from the new notes.
4. Opens a VERSION-bump PR against main using the same idempotent open-or-skip logic as today.

When `source: release`, behavior is unchanged from today (idempotent cherry-pick patch flow).

## Non-goals

- **CHANGELOG.md backport** from release to main. The 3.1.1 entry will not appear in main's `CHANGELOG.md` after a from-main 3.2.0 release. GitHub Releases remains the canonical changelog. (Can be added later as `source: main, backport_changelog: true`.)
- **Hotfix-only-commit audit** (warn if release has commits whose patch-id isn't reachable from main). Out of scope.
- **CI gating** on the VERSION-bump PR. `ci.yaml` already has `paths-ignore: [VERSION]`. Workaround: include any second file change in the PR.
- **Auto-detecting source from `version_bump`** (patch → release, minor/major → main). Explicit is safer; auto-detect can be a later iteration once the convention is proven.

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

The job stays as one `prepare` job. Steps gain `if:` guards where they're mode-specific:

| Step | When |
|---|---|
| Check out `${{ inputs.source }}` (fetch-depth: 0) | always |
| Configure git author | always |
| Compute current + NEXT version (from VERSION on `$SOURCE`) | always |
| Ensure no different release is already in flight | always (refined filter, see below) |
| Fetch merged PRs for `milestone:${NEXT}` from main | `if: inputs.source == 'release'` |
| Open porting PRs against `release` (existing idempotent loop) | `if: inputs.source == 'release'` |
| Label cherry-picked-into-release PRs as `released-as-hotfix` | `if: inputs.source == 'main'` |
| Open the version-trigger PR against `${{ inputs.source }}` (existing idempotent logic, parameterized) | always |

### "In-flight" guard (refined for both modes)

Replace the current "any open PR against release except port/NEXT/* and version/NEXT" with a guard that only catches **release-coordinating PRs for other versions**, scoped to `$SOURCE`:

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

### Permissions

The job's `permissions:` block needs `issues: write` added (alongside the existing `contents: write` and `pull-requests: write`) so the labeling step can create the `released-as-hotfix` label if missing and apply labels to PRs. GitHub treats labels as an issue resource even when applied to PRs.

### Hotfix labeling step (main mode only)

The mechanism: every porting cherry-pick uses `git cherry-pick -x`, which appends `(cherry picked from commit <SHA>)` to the commit message. We can walk release's commits since the previous tag, extract those SHAs, resolve each to a main PR via the commit→PR API, and add the `released-as-hotfix` label.

```bash
set -euo pipefail

git fetch origin release --tags

if ! prev_tag=$(git describe --tags --abbrev=0 origin/release 2>/dev/null); then
  echo "No previous tag on release — skipping hotfix labeling."
  exit 0
fi
echo "Previous release tag: ${prev_tag}"

# Ensure the label exists (idempotent)
gh label list --json name --jq '.[].name' | grep -qx released-as-hotfix \
  || gh label create released-as-hotfix --color BFD4F2 \
       --description "Already shipped in a hotfix release; exclude from next from-main release notes"

# Extract original SHAs from cherry-pick footers on release since prev_tag
mapfile -t shas < <(
  git log "${prev_tag}..origin/release" --pretty=%B \
  | grep -oE 'cherry picked from commit [0-9a-f]{40}' \
  | awk '{print $NF}' | sort -u
)

if [ "${#shas[@]}" -eq 0 ]; then
  echo "No cherry-picked commits found since ${prev_tag}."
  exit 0
fi
echo "Found ${#shas[@]} cherry-picked SHA(s)."

for sha in "${shas[@]}"; do
  pr_num=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${sha}/pulls" \
    --jq '.[] | select(.base.ref == "main") | .number' | head -n1)
  if [ -z "$pr_num" ]; then
    echo "  ${sha}: no main PR found, skipping"
    continue
  fi
  echo "  ${sha} -> PR #${pr_num}: labeling 'released-as-hotfix'"
  gh pr edit "$pr_num" --add-label released-as-hotfix
done
```

Notes:
- **Idempotent.** Re-applying the label is a no-op. Re-running the workflow is safe.
- **Quietly skips orphans.** Direct commits to release (no associated main PR) are reported and skipped — they're the audit case we deliberately left out of scope.
- **Bounded to "since previous tag".** Doesn't relabel PRs from earlier hotfix series; only the most recent hotfix-set.
- **Label color** `BFD4F2` is a light blue distinct from `skip-release-notes` (`65CEDB`). Cosmetic only.

### Parameterized version-trigger step

The existing version-trigger step is unchanged in structure (probe → orphan-cleanup → push + create) but switches three hardcoded references from `release` to `${SOURCE}`:

- `gh pr list --head "$branch" --base release --state all ...` → `--base "$SOURCE"`
- `git checkout release` → `git checkout "$SOURCE"`
- `gh pr create --base release ...` → `--base "$SOURCE"`

The branch name, title, body, and `skip-release-notes` label are unchanged: `version/${NEXT}`, `Trigger release ${NEXT}`, etc. `release.yaml` doesn't distinguish — it just watches VERSION changes on either branch.

The PR body's current advisory text ("Do not merge until all porting PRs against `release` have been merged — the *Validate Release Trigger PR* check enforces this") is **release-specific** and is replaced when source=main. Concrete bodies:

- **source=release** (unchanged): `Bumps the VERSION file to **${NEXT}**.\n\nMerging this PR triggers the release workflow. Do not merge until all porting PRs against \`release\` have been merged — the *Validate Release Trigger PR* check enforces this.`
- **source=main**: `Bumps the VERSION file to **${NEXT}** on \`main\`.\n\nMerging this PR triggers the release workflow from main HEAD. release.yaml will tag ${NEXT} and cross-merge main into release automatically. Note: there is no automated validation on PRs into \`main\` — review carefully.`

## Tests

All run on `balanza/trento_web` (origin) by dispatching the workflow from a feature branch:

1. **Backward compat (source=release, current flow)** — clean state, dispatch with `source=release, version_bump=patch`. Expected: identical to today's behavior — porting PR(s) + version-trigger PR opened against release.
2. **From-main basic** — clean state, dispatch with `source=main, version_bump=minor`. Expected: only the version-trigger PR opens, against main. Labeling step runs but finds no cherry-picks (no prior hotfix). VERSION on main bumped via the PR.
3. **From-main with prior hotfix** — set up: cherry-pick a known PR onto release via the release flow first (so a `port/X/pr-N` commit with `(cherry picked from commit SHA)` footer exists), tag it. Then dispatch `source=main, version_bump=minor`. Expected: the labeling step finds the original main PR and applies `released-as-hotfix`.
4. **In-flight guard, main mode** — set up: open a stub `version/9.9.5` PR against main. Dispatch `source=main, version_bump=minor` (NEXT=9.10.0). Expected: fails with "Found 1 open release-coordinating PR(s) for a different version".
5. **In-flight guard, release mode (regression)** — verify that ordinary unrelated PRs against release no longer block the guard (the refined filter). Set up: open a non-port, non-version PR against release. Dispatch with `source=release`. Expected: guard passes; existing logic continues.
6. **Re-run safety, main mode** — run test 2 successfully. Re-run with same inputs. Expected: version-trigger probe says "already open — nothing to do" (the idempotent logic from the prior spec applies unchanged because we parameterized `--base $SOURCE`).

Pass criteria: each expected log line appears; final repo state matches.

## Out-of-scope mitigations the human still owns

Documented in this spec for completeness; not implemented:

- **CHANGELOG.md backport**: before triggering a from-main release, open a small PR adding the prior hotfix section to main's CHANGELOG.md. Otherwise main and (post-cross-merge) release will permanently skip from 3.1.0 → 3.2.0 in the markdown file.
- **Hotfix-only-commit audit**: `git log main..release --no-merges` will reveal any commits unique to release. The cross-merge from main into release (with `-X theirs`) will silently overwrite their content. Backport anything you want to keep.
- **CI on the VERSION-bump PR**: include any non-VERSION file change to defeat `paths-ignore: [VERSION]`.
- **Two simultaneous from-main releases**: the `concurrency: prepare-release` group prevents two workflow runs at once, and the in-flight guard prevents starting a release while another is half-merged. Don't bypass either.
