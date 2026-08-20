# Contributing

## What to know before your first PR

Cordon is a border layer, not a heuristic. Two rules follow from that, and they matter more than code style.

**Rule 1: determinism.** There are no model calls in the hot path. If a change cannot be reproduced on the same input with the same result, it does not belong in the core.

**Rule 2: the `scope` module never sees untrusted content.** Never. This is not an optimization or a convenience, it is the single reason the scheme works at all. A PR that passes even one string from a document, a web page or a tool result into `scope` will be rejected without discussing the details.

## Process

1. Open an issue before writing code if the change alters behaviour. This does not apply to typos and documentation.
2. Tests first. A failing test that demonstrates the defect or describes the new behaviour, then the implementation. The PR should make it visible that the test really did fail.
3. One PR is one thought. Do not mix a new check with the refactoring around it.

## Running locally

```bash
npm install
npm test
npm run typecheck
```

Both must be green before you open a PR.

## About test data

In code and tests, invisible characters are written as escape sequences (`\u200B`), never pasted literally. A literal invisible character is unreadable in a diff during review, and that is exactly the class of problem this project exists for.

Put attack samples in the corpus, not in separate ad hoc tests. Every sample needs a pair: the harmful input and a similar harmless one that must pass through untouched. A filter without the second half of the corpus inevitably starts damaging normal text.

## Style

TypeScript, ESM, imports with the `.js` extension. No semicolons, single quotes, two-space indentation. Comments in English; they explain "why", not "what".
