---
title: 'shipper issue'
description: 'Inspect shipper-managed issues by workflow state without advancing the pipeline.'
---

# shipper issue

`shipper issue` is the read-only inspection cluster for shipper-managed issues: it surfaces workflow state (including `--status` short names such as `planned` and `implemented`) without advancing labels, leaving future read/inspect subcommands in the same group.

- [shipper issue list](./list) - List shipper-managed issues by pipeline status
