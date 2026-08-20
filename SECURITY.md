# Security policy

Cordon is itself a defence mechanism, so bypassing Cordon is not "a bug" but a vulnerability. Treat a finding accordingly and do not publish it right away.

## How to report

Privately, through GitHub: the **Security** tab > **Report a vulnerability**. There is no need to open a public issue, even if the finding looks minor.

What helps us understand it quickly:

* the minimal input that reproduces the bypass, preferably as a file rather than inline in the message;
* which version of Cordon and which harness (Claude Code, Cowork, Gemini CLI, an MCP proxy, and so on);
* what Cordon returned and what it should have returned.

We reply within 72 hours. If there is no reply in that time, send it again: the notification got lost.

## What counts as a vulnerability

* An input that passes `sanitize` while carrying an instruction invisible to a human in ordinary viewing.
* A tool call that passes `gate` while falling outside the issued intent certificate.
* Any way to make the `scope` module see untrusted content. That is the core of the scheme, and breaking it devalues the whole construction.
* Changing Cordon's configuration or hooks by means of the agent itself.
* A false "clean" on an input where the report was obliged to show a finding.

## What does not count as a vulnerability

The full list of limitations lives in the spec, in the section on residual risks. In short:

* **Persuasive visible content.** A review that is honestly visible to the human and still sways the agent towards the desired conclusion is outside Cordon's scope. Cordon separates data from commands; it does not judge truthfulness.
* **Jailbreaking the model itself.** A prompt that lifts the model's restrictions directly from the user is the model vendor's responsibility, not a border layer's.
* **A false positive.** Unpleasant, but it is an issue, not a vulnerability: the system is designed to refuse in the doubtful case.
* **An attack on the harness that goes around Cordon.** If the harness allows a tool to be invoked bypassing the interceptor, that is an integration defect. Report it anyway: most likely we have described the coverage level incorrectly.

## Safe harbour

Good-faith research is welcome. Do not touch other people's data or accounts, do not run load attacks, work on your own copy. Do that and we will have no complaints.
