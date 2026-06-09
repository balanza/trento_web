# Prepare-release workflow: idempotent + auto-heal design

**Status:** Approved
**Date:** 2026-06-09
**Affects:** `.github/workflows/prepare-release.yaml`

## Problem

`prepare-release.yaml` is not safe to re-run after partial failure. Each step (porting PRs, version-trigger PR) does `git push` then `gh pr create`; if PR creation fails (e.g., missing label), the branch is left on the remote without a PR. Re-running then collides with the orphan branch (non-fast-forward push) or trips the "no release in flight" guard against its own prior-run leftovers.

Observed example (run 27210429356): `gh pr create --label skip-release-notes` failed mid-step, leaving `version/9.9.1` orphaned; subsequent re-runs failed at the push.

## Goal

A re-run of `prepare-release` for the **same** `NEXT` version transparently picks up where a prior run left off. A run for a **different** in-flight version still fails loudly.

## Non-goals

- Restarting a release that was already triggered (merged version-trigger PR).
- Auto-recreating PRs that a reviewer explicitly closed.
- Making the workflow safe under concurrent runs (still gated by `concurrency: prepare-release`).

## Design

### Per-item state model

For each piece of work (each porting PR, the version-trigger PR), look up the existing PR by head branch and act on its state:

| Item state | Action |
|---|---|
| PR OPEN | Skip — already done |
| PR MERGED (porting) | Skip — already on `release` |
| PR MERGED (version-trigger) | **Abort** — release already triggered |
| PR CLOSED (porting) | Skip with warning — respect reviewer's rejection |
| PR CLOSED (version-trigger) | **Abort** — tell user to delete manually if they want to retry |
| No PR, orphan branch exists | Delete orphan, recreate fresh |
| Nothing | Fresh creation (current behavior) |

### "In-flight" guard refinement

The existing "no release in flight" check fails on **any** open PR against `release`. Refine it to fail only on PRs whose head doesn't match `port/${NEXT}/*` or `version/${NEXT}` — so leftovers from a prior run of the **same** version don't block resume, but an in-flight **different** version does.

### Cherry-pick conflict handling

Cherry-pick conflicts still abort the workflow. The error message is updated to reflect auto-resume: the user resolves the one conflict (checks out the branch, completes the port, pushes, opens a PR), then re-runs to continue with the remaining ports. Already-created porting PRs are skipped on the resumed run.

## Implementation

Three localized edits to `prepare-release.yaml`:

1. **Hoist `NEXT` to a step-level `env:`** on both the "in-flight" check and the porting loop, so the `jq --arg ver` pattern-match works without YAML interpolation gymnastics.
2. **"Ensure no release is in flight"**: filter the `gh pr list` output through `jq` to exclude PRs matching `port/${NEXT}/*` or `version/${NEXT}` before counting.
3. **Porting loop body**: probe `gh pr list --head $branch --state all` at the top of each iteration; switch on state with `case`; if no PR but orphan branch exists, `git push origin --delete` before the cherry-pick.
4. **Version-trigger step**: same probe pattern; OPEN → exit 0; CLOSED/MERGED → exit 1 with explicit user instruction; otherwise delete orphan and proceed.

The `case` statement is the same shape in both places; differs only in the CLOSED/MERGED branches.

## Tests

All run on `balanza/trento_web` (origin), dispatched with `--ref` pointing at the feature branch:

1. **Clean run from empty state** — close all release PRs + delete branches; dispatch; expect 2 fresh PRs (1 porting, 1 version-trigger).
2. **Resume after version-trigger failure** — from a successful state, close+delete the version-trigger PR/branch only; re-dispatch; expect porting step skips with "already open", version-trigger step recreates fresh.
3. **Closed version-trigger PR** — from successful state, close (don't delete branch) the version-trigger PR; re-dispatch; expect workflow fails at version-trigger step with "delete it manually" message.
4. **Orphan port branch reaped** — from empty state, manually push `port/9.9.1/pr-23` with no PR; dispatch; expect orphan deleted then recreated via cherry-pick.

Pass criteria: each test's expected log line appears in the run's step output, and final repo state matches the expectation.
