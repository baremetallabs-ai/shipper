---
title: 'CLI'
description: 'Reference for every shipper CLI command.'
---

# CLI

Use these pages as the generated reference for the current Shipper CLI surface.

## Getting started

- [shipper init](./init) - Initialize shipper in the current repository
- [shipper setup](./setup) - Configure repository settings with an agent

## Issue intake

- [shipper new](./new) - Create a new issue interactively or from a request
- [shipper adopt](./adopt) - Adopt an existing issue into the shipper workflow
- [shipper priority](./priority) - Set priority on an issue

## Workflow

- [shipper next](./next) - Advance an issue to the next workflow step
- [shipper groom](./groom) - Groom an existing issue
- [shipper design](./design) - Run technical design review on an issue
- [shipper plan](./plan) - Create an implementation plan for an issue
- [shipper implement](./implement) - Implement an issue in a worktree
- [shipper ship](./ship) - Run the full workflow end-to-end

## Operations

- [shipper merge](./merge) - Run the merge queue for PRs labeled shipper:ready
- [shipper reset](./reset) - Reset an issue back to an earlier workflow stage
- [shipper unblock](./unblock) - Check if a blocked issue can proceed
- [shipper unlock](./unlock) - Force-release an issue lock or sweep stale locks
- [shipper eject](./eject) - Scaffold prompt overrides for customization

## Groups

- [shipper issue](./issue/) - Issue commands
- [shipper pr](./pr/) - Pull request commands
