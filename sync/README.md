# sync/

This repo is **derived** from two parent repos (named in `manifest.json`) until the teacher retires them.
`site/`, `services/`, `content/`, `docs/follow-alongs/`, `docs/quiz/` are mirror targets: every sync
rebuilds them from the parents' committed `HEAD`. **Never hand-edit a mirrored file.** Change it in the
parent and sync, or, if the change is only true here, add a transform.

## Commands

```bash
node sync/sync.mjs           # rebuild all mirrors, apply transforms + identity rewrite, update state.json
node sync/sync.mjs --check   # read-only: lists parent commits not yet synced; exit 1 if any
node sync/sync.mjs --parents-root <dir>   # find the parent checkouts in <dir> (by folder name), e.g. from a worktree
```

A sync:

1. Reads each parent's `HEAD` with `git archive` (never the working tree; a dirty parent is only a warning)
   and extracts it to `sync/.work/<id>/` (gitignored).
2. Copies each mirror's subtree, minus `exclude` (`keep` overrides `exclude`; gitignore-style globs
   relative to the mirror's `from`), plus the single `files`. Paths in `native` are never written or
   deleted. Two mirrors writing the same path is an error.
3. Applies `transforms.mjs`, then the identity rewrite (`config/identity.json`: `parents` -> `current`,
   in `rewrite_order`, text files under `rewrite_scope` only). After the explicit keys come forms
   derived from them (`sync/rewrite.mjs` `derivedForms`): the `wss://` form of `roster_url` and
   `relay_url`, and for `site_base` its JS-regex-escaped form, origin, and host (plain and escaped).
4. Deletes files under the targets that the parents no longer have, including tracked files that a
   .gitignore matches (untracked gitignored local files such as `.env` and `node_modules/` are left
   alone), and writes only files whose bytes changed. Line endings
   are preserved byte for byte.
5. Writes `state.json` (parent shas, branches, dirty flags, time) only if something changed, so a
   second sync with no parent change leaves `git status` clean.

After a sync: review `git diff`, run `npm test`, commit.

## Adding a transform

Add an entry to the array in `transforms.mjs`:

```js
{
  id: 'short-name',
  why: 'the failing test, broken import, or wrong path that justifies it',
  files: ['site/tests/*.test.js', '!site/tests/skip-me.test.js'],   // repo-root globs; "!" excludes
  replace: [['literal from', 'literal to']],                           // in order, not regex
}
```

Rules: literal replacement only; `to` must not contain `from`; keep it as narrow as the evidence.
Run `node sync/sync.mjs` and read the summary: each transform prints its hit count, and a named file
with zero hits is a warning (the parent changed; fix or delete the transform).

`rewrite.mjs` holds the glob, binary-detection and literal-rewrite helpers shared with
`scripts/rebrand.mjs`.
