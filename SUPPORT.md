# Support

Four kinds of question, four different places. Picking the right one is not bureaucracy: a bypass of the defence posted in a public issue is a working exploit published before there is a fix.

## You found a way past Cordon

**Do not open an issue.** Go to the **Security** tab, **Report a vulnerability**. That covers anything where content invisible to a human reaches the model, a call escapes its certificate, or `scope` is made to see untrusted text. The details, and what does not count, are in [SECURITY.md](SECURITY.md). Reply within 72 hours; if it is quiet, send it again, because the notification got lost.

## Something is broken

Open an issue with the bug-report template. What makes a report solvable, roughly in order of how often it is the missing piece:

* the input, as a file rather than pasted inline. Invisible characters do not survive a copy through a browser, and the invisible characters are usually the whole story;
* the output of `cordon doctor`, whole, including the warnings. It names the harness, the policy and whether the mechanism itself is intact;
* which harness and which version, and whether the hook is actually registered (`/hooks`);
* what happened, and what you expected instead.

A false positive is a bug and belongs here: Cordon damaging a legitimate document is a defect in a module, not a reason to switch the module off. If you have a document Cordon spoils, that document is worth more than the report; say so and it can go into the loyalty corpus, where it will keep the defect from coming back.

## You want to know whether Cordon covers something

Open a discussion, or an issue if you would rather. The honest answer is often "no", and there is a section for it: ["What this is NOT"](README.md#what-this-is-not) in the README, plus the residual risks in the design spec. Cordon separates data from commands; it does not judge whether content is true, and it does not defend against a page that persuades your agent in plain sight.

## You want to change something

[CONTRIBUTING.md](CONTRIBUTING.md). Two rules there outrank everything else: no model calls in the hot path, and `scope` never sees untrusted content. A PR that breaks either is rejected without discussing the details, so it is worth reading the two paragraphs before writing the code.

## What there is no channel for

There is no paid support, no SLA and no private consulting queue. Cordon is a one-person MIT project. If you are deciding whether to put it between an autonomous agent and real money, the thing to read is not a support page but the limitations, and then `cordon doctor` on your own configuration.
