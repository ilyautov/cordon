# Working in this repository

Instructions for a coding agent. A human reading this will not be harmed by it either.

Cordon is a border layer between untrusted content and an agent's actions. That single fact decides most questions here, including several where the usual good advice points the other way.

## The three invariants

Break any of these and the change is wrong no matter how clean it is.

**1. No model calls in the hot path.** Nothing in `src/` may ask a model anything. Whatever decides has to be verifiable by reading the code and reproducible on the same input. Detecting maliciousness by meaning loses to an adaptive attacker and fires on honest text at the same time: a page explaining prompt injection is written out of the same phrases as an attack.

**2. `src/scope/` never sees untrusted content.** Not a summary of it, not a fragment, not a length. The certificate is derived from what the human said and from the policy, and from nothing else. This is the reason the whole scheme works; if a change makes a document, a web page or a tool result reach `scope`, the change is finished being discussed.

**3. Failure has to be loud.** Both harnesses read a crashed hook, a timed-out hook and an empty stdout as "let it through". So the hot path is synchronous and linear, the bundle is committed rather than built at install time, and a caught exception is never allowed to turn a `deny` into silence. When you add a `try`, say in the `catch` what happens to the decision.

## The map

```
src/sanitize/     the hidden layer: invisible characters, mixed scripts, hidden HTML,
                  encoded blocks, percent-encoding. Pure functions over strings
src/provenance/   who said this: atoms, shingles, the taint store
src/scope/        the intent certificate and effect classes. Untrusted content never enters
src/gate/         the decision on a call, plus the quarantine backstop. The exposure
                  rule lives here: the decision answers to the fact of reading
                  untrusted content, not only to a match against it
src/output/       the source-influence footer under the model's answer
src/session/      state between processes, and its expiry
src/policy/       loading and defaults, plus protection of Cordon's own files
src/notify/       the channel to the owner that the agent cannot reach
src/adapters/     claude-code and gemini-cli: translate harness events, hold no security logic;
                  mcp: a stdio JSON-RPC gateway in front of one upstream server, same rule
src/cordon.ts     wiring. src/cli.ts: scan, hook, mcp, doctor
```

The adapters holding no logic is load-bearing rather than tidy: the same decision has to come out of both harnesses, and a rule that lives in an adapter is a rule the other harness does not have.

## Commands

```bash
npm install
npm test            # vitest, the whole suite, seconds not minutes
npm run typecheck
npm run build       # tsc, then the esbuild bundle into plugin/dist/cli.js
node scripts/no-invisible.mjs
```

All four have to be green before a commit. `npm run build` matters more than it looks: `plugin/dist/cli.js` is committed, so a source change without a rebuild ships a bundle that does not match the sources, and the bundle is what actually runs in the harness.

## Tests

Write the failing test first, and make sure it fails for the reason you think it does before implementing anything.

**Invisible characters are written as escape sequences.** `\u200B`, never the literal character. `scripts/no-invisible.mjs` enforces this over `src`, `tests` and `scripts`, and it runs in CI. The reason is the project's own subject: a literal invisible character is indistinguishable from emptiness in a diff, so a reviewer cannot see what a test asserts.

**An attack sample goes into the corpus, not into an ad hoc test.** `tests/fixtures/attacks.ts` pins vectors that once slipped through. Every sample needs its pair in `tests/fixtures/loyalty/`: a similar harmless document that must pass untouched. A filter kept honest by only half a corpus starts eating normal text within a week.

**The loyalty corpus may not be weakened.** A false positive on it is a defect in a module. Deleting or editing the sample to make the suite green is the one change that will not be accepted, because the corpus is the only thing standing between this and a filter nobody can use.

Some fixtures are deliberately not in English: `tests/fixtures/loyalty/i18n.txt` is multilingual to prove there are no false positives on real multi-script text, and the homoglyph data in `tests/sanitize/mixed-script.test.ts` is Cyrillic because that is what the attack is made of. Leave them as they are.

## Style

TypeScript, ESM, imports carry the `.js` extension. No semicolons, single quotes, two-space indent. Everything in the repository is in English: code, comments, tests, commit messages, docs. The exceptions are the fixtures named above and `README.ru.md`, which is a translation on purpose.

Comments explain why, not what. In this codebase that mostly means recording which attack or which harness behaviour forced the shape of the code, because that reasoning is not recoverable from the code afterwards.

Commit messages: `type: what changed`, in the imperative, English, and the body says why when the why is not obvious.

## Things that look like improvements and are not

* **Caching a decision across calls.** State that survives a call is state an attacker can aim at. What persists is deliberate and lives in `src/session/`, with an expiry.
* **Making the filter cleverer about intent.** See invariant 1.
* **Widening a scope so a blocked call goes through.** `narrow` intersects and never adds. If an agent is blocked, the certificate or the policy is what should change, in the open, not the code path.
* **Catching an exception to keep things running.** See invariant 3.
* **Deleting a corpus sample to fix a red test.**
* **Adding a dependency.** There are two at runtime, `htmlparser2` and `yaml`. Every new one is code that runs inside a security boundary and that nobody in this project has read.
