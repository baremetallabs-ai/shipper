# Releasing

Shipper publishes from a tag push. Tagging is the release trigger; everything else is preparation.

## What gets published

A `v*` tag on `main` runs `.github/workflows/publish.yml`, which has two jobs:

- **publish-npm** (Ubuntu, Node 24) — runs lint, format:check, type-check, build, test, then publishes `@baremetallabs-ai/shipper-core` (idempotent — skipped if the version already exists) and `@baremetallabs-ai/shipper-cli` to the public npm registry with provenance.
- **publish-desktop** (macOS, Node 22) — builds `packages/core` then `packages/desktop`, packages with `electron-builder --mac --arm64 --publish never`, and uploads `.dmg` / `.zip` artifacts to the GitHub Release for the tag (creating the release with `--generate-notes` if it does not already exist).

`packages/mcp` is private. Its version is checked for tag alignment but it is not published.

## npm authentication

npm publishing uses **Trusted Publishers / OIDC**, not `NPM_TOKEN`. The publish job declares `permissions: id-token: write` and `actions/setup-node` writes the registry URL; `npm publish --provenance` exchanges the GitHub OIDC token with npm. Configuration lives on the npm package settings page (Trusted Publisher entry pointing at `baremetallabs-ai/shipper` + the `Publish` workflow); there is no secret to rotate.

Node 24 is required on the publish-npm job for OIDC Trusted Publisher support — do not downgrade.

## Version alignment

Every release must keep four versions in lockstep:

- `packages/cli/package.json`
- `packages/core/package.json`
- `packages/desktop/package.json`
- `packages/mcp/package.json`

The publish workflow fails the build if `${GITHUB_REF_NAME#v}` does not match any of the four. Bump all four together.

There is also a CLI version **fingerprint** in `.shipper/settings.json` (`cliVersion`) that must match `packages/cli/package.json`'s `version`. The pre-push hook and the `check` CI job both run `npm run check:cli-version-fingerprint` and fail on drift. After bumping the CLI version, run `shipper init` to refresh the fingerprint.

## Cutting a release

1. Make sure `main` is green and you are at the commit you want to release.
2. Bump the four package versions to the new `X.Y.Z` (use the same number across all four).
3. Run `shipper init` to refresh `.shipper/settings.json`'s `cliVersion`.
4. Update `CHANGELOG.md`:
   - Move `[Unreleased]` entries under a new `## [X.Y.Z]` section.
   - Add a fresh empty `## [Unreleased]` at the top.
   - Update the compare links at the bottom (`[Unreleased]` -> `vX.Y.Z...HEAD`, plus the new `[X.Y.Z]` link).
5. Open a release-prep PR, get it green, merge.
6. Pull `main` locally, then tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
7. Watch the `Publish` workflow. If `publish-npm` succeeds but `publish-desktop` fails, you can re-run just the desktop job — the npm publish step is idempotent for `core` and the cli step will fail-fast on a duplicate version, which is the desired behaviour.

## After publishing

- Verify the npm pages show the new version with provenance: `@baremetallabs-ai/shipper-cli` and `@baremetallabs-ai/shipper-core`.
- Verify the GitHub Release was created with the desktop `.dmg` and `.zip` attached.
- Smoke-test: `npm install -g @baremetallabs-ai/shipper-cli@X.Y.Z && shipper --version`.

## Things that have bitten us

- **`electron-builder` without `--publish never`** will try to upload artifacts before our explicit `gh release` step and racy-fail. Always pass `--publish never`.
- **Node < 24 on publish-npm** breaks OIDC Trusted Publisher exchange. Setup-node must pin Node 24.
- **Forgetting to refresh the cliVersion fingerprint** after a manifest bump trips the pre-push hook. The fix is `shipper init`, not editing the file by hand.
- **Tag without bumping all four packages** fails the workflow's version-match step. The MCP package is private but still gated.
