---
title: 'shipper pr'
description: 'Follow pull request workflow stages from implemented issue through review and remediation.'
---

# shipper pr

`shipper pr` covers the pull request side of the label-driven workflow: `shipper pr open` runs when an issue reaches `shipper:implemented`, `shipper pr review` runs when an issue reaches `shipper:pr-open`, and `shipper pr remediate` runs when an issue reaches `shipper:pr-reviewed`. Most users invoke these through `shipper next` or `shipper ship`, which dispatch the correct subcommand from the current workflow label; see the [state machine](/concepts/state-machine/) for the full transition table.

- [shipper pr review](./review) - Review a pull request
- [shipper pr open](./open) - Open a pull request for an implemented issue
- [shipper pr remediate](./remediate) - Remediate a pull request after review feedback
