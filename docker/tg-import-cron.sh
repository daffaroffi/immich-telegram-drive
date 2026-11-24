#!/usr/bin/env bash
# Continuous Telegram -> Immich mapping.
# Runs the admin importer for both the storage chat and Saved Messages,
# skipping immutable test artifacts and files too large for the VPS disk.
# Large media stays in Telegram and is restored on demand by the server.
set -euo pipefail

BASE=http://127.0.0.1:2283
EMAIL="dapa@utusu.my.id"
PASS_FILE=/root/immich-telegram/docker/.import-password
LOG=/var/log/immich-telegram-import.log

[ -f "$PASS_FILE" ] || { echo "no password file" >&2; exit 1; }

FREE_KB=$(df --output=avail / | tail -1 | tr -d ' ')
# Keep at least 1.5 GiB free before importing more.
if [ "$FREE_KB" -lt 1572864 ]; then
  echo "$(date -Is) skip: only ${FREE_KB}KB free" >> "$LOG"
  exit 0
fi

TOKEN=$(curl -s --max-time 10 -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$(cat "$PASS_FILE")\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("accessToken",""))')

[ -n "$TOKEN" ] || { echo "$(date -Is) login failed" >> "$LOG"; exit 1; }

for SOURCE in self chat; do
  OUT=$(curl -s --max-time 900 -X POST "$BASE/api/admin/telegram/import" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"limit\":500,\"source\":\"$SOURCE\",\"maxBytes\":60000000}")
  echo "$(date -Is) $SOURCE -> $OUT" >> "$LOG"
done
