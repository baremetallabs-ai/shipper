#!/usr/bin/env bash
set -euo pipefail

SETTINGS_FILE=".shipper/settings.json"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "Warning: $SETTINGS_FILE not found, skipping dependency install." >&2
  exit 0
fi

INSTALL_CMD=$(node -e "require('fs/promises').readFile('$SETTINGS_FILE','utf8').then((raw)=>{const s=JSON.parse(raw);if(s.installCommand)process.stdout.write(s.installCommand)}).catch(()=>{})" 2>/dev/null || true)

if [ -z "$INSTALL_CMD" ]; then
  echo "Warning: No installCommand configured in $SETTINGS_FILE, skipping." >&2
  exit 0
fi

echo "Running: $INSTALL_CMD"
eval "$INSTALL_CMD"
