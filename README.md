# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/taijunhuang312-lgtm/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/taijunhuang312-lgtm/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
one patch tool for every AI edit format.

## What it does

`mend` applies an edit that an AI model wrote to a tree of text files, in
one of four formats:

- **unified diffs** — even with wrong line numbers (the hunk takes the
  occurrence nearest to its stated position), `\ No newline at end of file`
  handling, creates, deletes and moves;
- **SEARCH/REPLACE blocks** — with the file path taken from the nearest line
  above the block;
- **V4A patches** — `*** Begin Patch` / `*** End Patch`, Add / Delete /
  Update File sections, `@@` anchors, `*** Move to:` and
  `*** End of File` chunks;
- **JSON tool calls** — `create`, `str_replace` and `insert`, as one JSON
  array or as JSON Lines.

Lines are found at three tiers of fuzziness — exact, then trailing
whitespace ignored, then leading and trailing whitespace ignored (with
re-indentation of the new lines) — unless `--strict` asks for exact matches
only. Every edit is applied to the tree as earlier edits left it, and a
failed edit changes nothing: either every file is written or none is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of
  the tree); when it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` with one `A` / `D` / `M` / `R` line per changed path and an
`ok: <n> files` line; `1` with one `error: <code> <path>` line per failed
edit and a `failed: <k> of <n> edits` line, nothing written; `2` with a
single `error: usage` / `error: no-patch` / `error: format` /
`error: parse <N>` line, nothing written.

## Running it

Node 22 or later, standard library only, no network, no dependencies:

    node main.ts fix.patch
    cat fix.patch | node main.ts -

The practice set (100 checks) is in the kit's
`program/generator/practice.json`; `node check.ts <that file>` runs it
against `main.ts` from this directory.

## Files

- `main.ts` — the whole tool (written for this entry, from `SPEC.md`).
- `runner.ts`, `check.ts` — the competition kit's trial harness and
  practice checker, copied as-is.
- `SPEC.md` — the competition specification (in the kit).
