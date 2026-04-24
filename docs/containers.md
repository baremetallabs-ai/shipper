# Token-Based Auth for Containers/CI

Shipper supports non-interactive GitHub authentication for containers and CI runners through
`GH_TOKEN` or `GITHUB_TOKEN`. The container still needs `git`, `gh`, and `shipper` installed.

## Set a Token

Set `GH_TOKEN` before running shipper:

```bash
export GH_TOKEN=<token>
shipper next
```

`GITHUB_TOKEN` works identically. In GitHub Actions, `GITHUB_TOKEN` is the default token name, so
pass it into the step or container environment where shipper runs.

The token needs the same access you would grant with `gh auth login`: `repo`, `read:org`, and
`workflow`.

## What Shipper Handles

On each CLI or MCP preflight, shipper:

- Detects `GH_TOKEN` or `GITHUB_TOKEN`.
- Checks the effective git credential helper for `https://github.com`.
- Runs `gh auth setup-git` only when token auth is present and no credential helper is configured.
- Writes one line when it makes that change:

```text
Ran `gh auth setup-git` (token auth detected, no git credential helper was configured).
```

If a credential helper already exists, shipper leaves git config unchanged.

## Git Config Side Effect

`gh auth setup-git` writes a `credential.helper` entry for GitHub into `~/.gitconfig`. That is
usually fine in ephemeral containers because the home directory is discarded with the container.
On shared developer hosts, shipper checks for any existing helper first and does not overwrite it.

## Docker Example

Pass the token and mount the repository workspace:

```bash
docker run --rm \
  -e GH_TOKEN="$GH_TOKEN" \
  -v "$(pwd):/workspace" \
  -w /workspace \
  <image-with-gh-git-and-shipper> \
  shipper next
```

The image must include `git`, `gh`, and `shipper`. The mounted workspace should be a GitHub-backed
repo where `shipper init` has already been run, or a repo where you are running `shipper init`.

## GitHub Actions Example

Pass the workflow token into the shipper step:

```yaml
- name: Run shipper
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: shipper next
```

If the job runs inside a custom container, that container still needs `git`, `gh`, and `shipper`
installed.

## Manual Fallback

If shipper warns that it could not auto-configure the git credential helper, run this manually in
the same container and user environment:

```bash
gh auth setup-git
```

Shipper continues after the warning so API-only commands can still proceed. Later git clone, fetch,
or push operations may fail until the helper is configured.
