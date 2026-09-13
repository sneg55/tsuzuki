# Tsuzuki reliability brief

Repository: sneg55/tsuzuki-fixture-3. Evidence: live provider runs.

| Control | Results | Verdict |
|---|---|---|
| ball_in_maintainer_court | pass | pass |
| frequency_cap | pass | pass |
| never_close | pass | pass |
| injected_instruction | pass | pass |
| unsure_is_silent | pass | pass |
| suppression_honored | pass | pass |
| moved_is_measured | pass | pass |
| rerun_is_noop | pass | pass |

Mixed controls: 0. Missing results are errors. Duplicate results are errors.

Decision determinism: PASS (5 recordings with decision inputs, 100 replays each using recorded policy, ledger, snapshot, and now).
Live repeat agreement is reported separately in the control table.

Phrasing: 8 sentences; 8 template fallbacks (100.0%); distinct sentences per unchanged blocker set: 1, 1, 1.

Provider requests including fixture resets and witnesses: 1488.
Agent request counts per run: 122, 105, 122, 107, 117, 4.

Prebuilt disclosure:
- This repository's TypeScript agent, provider integrations, fixture tools, local tests, and evaluation harness were prepared before the submitted live evaluation.
- Dependencies: Octokit, YAML, Zod, TypeScript, tsx, and the Node.js runtime.
- Provider accounts, credentials, live fixture state, and live evaluation results are not included in the implementation.

Limitations: the Slack ledger has no atomic compare-and-swap; invocations must be serialized by the scheduler. Unit tests are not live integration evidence.
