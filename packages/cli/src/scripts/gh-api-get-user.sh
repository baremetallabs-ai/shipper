#!/usr/bin/env bash
set -euo pipefail
exec gh api /user --jq .login
