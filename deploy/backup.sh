#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
docker compose --env-file "$ROOT/.env" -f "$ROOT/deploy/compose.yaml" exec -T app \
  node dist/server/backup.js "/app/data/backups/kilele-$STAMP.sqlite"
# Configure encrypted off-site copying of the database AND .manifest.json separately.
