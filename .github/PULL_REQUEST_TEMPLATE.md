## What this changes

<!-- One or two sentences. If it changes behaviour, an issue should already exist: link it. -->

## Why

<!-- The attack, the false positive or the harness behaviour that forced it. This is the part
that cannot be recovered from the diff later. -->

## The invariants

Tick these yourself. A reviewer will check them anyway, but the point is that you looked.

- [ ] **No model call was added to the hot path.** The decision stays a pure function of the input.
- [ ] **`src/scope/` still does not see untrusted content.** No document, page or tool result reaches it, not even a fragment or a length.
- [ ] **Failure stays loud.** Any `catch` I added says what happens to the decision, and none of them can turn a `deny` into silence. A crashed or hanging hook is read by both harnesses as "let it through".

## Tests

- [ ] The test was written first and I watched it fail for the right reason.
- [ ] Invisible characters are written as escape sequences (`\u200B`), never as the literal character.
- [ ] A new attack sample went into `tests/fixtures/attacks.ts`, with its harmless twin in `tests/fixtures/loyalty/`.
- [ ] No loyalty sample was deleted or edited to make the suite green.

## Checks

```
npm test
npm run typecheck
npm run build
node scripts/no-invisible.mjs
```

- [ ] All four are green.
- [ ] `npm run build` was run and `plugin/dist/cli.js` is in the commit. The bundle is what actually runs inside the harness, so a source change without a rebuild ships code nobody tested.

<!-- If you ticked a box you are not sure about, say so here instead. An honest "I could not
check this one" is worth more than a full set of ticks. -->
