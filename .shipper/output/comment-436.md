## Implementation Summary

**Branch:** `shipper/436-fix-throw-on-missing-pr-spec-review-payload-for-ac`

### Changes made

- Added accept-only guards in `processResult()` so `pr_open` now throws `pr_open accept requires a pr_spec in result.json` when `pr_spec` is missing, and `pr_review` now throws `pr_review accept requires a review_payload in result.json` when `review_payload` is missing.
- Kept both new guards in the existing validation block ahead of PR creation, review submission, comment posting, and label transitions so no `gh` side effects run for these broken accept results.
- Added regression tests for both missing-payload cases in `packages/core/tests/lib/output-protocol.test.ts`, each asserting the descriptive error message and that `ghMock` records zero calls.

### Verification

- `npm run lint`
- `npm run format:check`
- `npm run type-check`
- `npm run build`
- `npm run test`
- `npm run test --workspace=packages/core -- output-protocol`
- Verified the new `pr_open` and `pr_review` regression tests reject with the expected messages and `ghMock` remains uncalled.
- Verified the existing `processes PR creation before posting the comment and changing labels` and `processes review submission before posting the comment and changing labels` tests still pass, preserving current accept behavior when payloads are present.

### Notes

- Non-accept behavior remains unchanged because the new validation is explicitly gated by `result.verdict === 'accept'`.
