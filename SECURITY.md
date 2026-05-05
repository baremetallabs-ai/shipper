# Security policy

## Reporting a vulnerability

Please **do not** report security issues via public GitHub issues, pull requests, or discussions.

Instead, report them privately by opening a [GitHub Security Advisory](https://github.com/baremetallabs-ai/shipper/security/advisories/new) on this repository. We will acknowledge your report and work with you on a coordinated disclosure timeline.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally with a minimal proof of concept.
- The Shipper version (`shipper --version`) and platform.
- Any suggested mitigation, if you have one.

## Supported versions

Shipper does not currently maintain backports. Security fixes are released against the latest published version on the public npm registry.

| Version | Supported          |
| ------- | ------------------ |
| 3.x     | :white_check_mark: |
| < 3.0   | :x:                |
