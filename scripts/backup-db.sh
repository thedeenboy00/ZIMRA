#!/usr/bin/env bash
# =============================================================================
# scripts/backup-db.sh — PostgreSQL Backup Script
# =============================================================================
# Dumps the Supabase PostgreSQL database and uploads to:
#   1. Local /backups/ directory (keep last 7 days)
#   2. Cloudflare R2 (or any S3-compatible bucket — keep last 30 days)
#
# Schedule via cron (run on your Render worker or a separate cron job):
#   0 2 * * * /app/scripts/backup-db.sh >> /var/log/zimra-backup.log 2>&1
#   (Runs at 02:00 UTC daily — midnight Zimbabwe time = UTC+2)
#
# Required environment variables:
#   DIRECT_URL        — Supabase direct connection string (port 5432)
#   BACKUP_S3_BUCKET  — S3/R2 bucket name (e.g., "zimra-pos-backups")
#   BACKUP_S3_ENDPOINT — S3 endpoint URL (e.g., https://<ACCOUNT>.r2.cloudflarestorage.com)
#   BACKUP_S3_ACCESS_KEY — S3/R2 access key ID
#   BACKUP_S3_SECRET_KEY — S3/R2 secret access key
#   BACKUP_ENCRYPTION_KEY — AES-256 passphrase for encrypting backup files
#
# Dependencies: pg_dump, openssl, aws CLI (or rclone)
# =============================================================================

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

BACKUP_DIR="${BACKUP_DIR:-/tmp/zimra-backups}"
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
BACKUP_FILENAME="zimra_pos_${TIMESTAMP}.sql.gz.enc"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILENAME}"
LOCAL_RETENTION_DAYS=7
S3_RETENTION_DAYS=30

# ─── Validate env vars ────────────────────────────────────────────────────────

required_vars=(
  "DIRECT_URL"
  "BACKUP_S3_BUCKET"
  "BACKUP_S3_ENDPOINT"
  "BACKUP_S3_ACCESS_KEY"
  "BACKUP_S3_SECRET_KEY"
  "BACKUP_ENCRYPTION_KEY"
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "[$(date -u +%T)] ERROR: Required environment variable '$var' is not set."
    exit 1
  fi
done

# ─── Prepare backup directory ─────────────────────────────────────────────────

mkdir -p "$BACKUP_DIR"
echo "[$(date -u +%T)] Starting backup → $BACKUP_FILENAME"

# ─── Run pg_dump ──────────────────────────────────────────────────────────────
# Pipe: pg_dump → gzip (compress) → openssl (encrypt) → file
# --no-owner: don't dump ownership (Supabase uses managed roles)
# --no-acl: don't dump ACLs (managed by Supabase)
# --format=plain: SQL text format — most portable for restores

pg_dump \
  "$DIRECT_URL" \
  --no-owner \
  --no-acl \
  --format=plain \
  --verbose \
  2>>"${BACKUP_DIR}/pg_dump_${TIMESTAMP}.log" \
| gzip --best \
| openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
    -pass "pass:${BACKUP_ENCRYPTION_KEY}" \
    -out "$BACKUP_PATH"

BACKUP_SIZE=$(du -sh "$BACKUP_PATH" | cut -f1)
echo "[$(date -u +%T)] Backup created: $BACKUP_PATH ($BACKUP_SIZE)"

# Verify the backup is non-empty
if [ ! -s "$BACKUP_PATH" ]; then
  echo "[$(date -u +%T)] ERROR: Backup file is empty. pg_dump may have failed."
  exit 1
fi

# ─── Upload to S3/R2 ──────────────────────────────────────────────────────────

echo "[$(date -u +%T)] Uploading to s3://${BACKUP_S3_BUCKET}/backups/${BACKUP_FILENAME}"

AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
aws s3 cp \
  "$BACKUP_PATH" \
  "s3://${BACKUP_S3_BUCKET}/backups/${BACKUP_FILENAME}" \
  --endpoint-url "$BACKUP_S3_ENDPOINT" \
  --storage-class STANDARD \
  --no-progress

echo "[$(date -u +%T)] Upload complete."

# ─── Prune old local backups ──────────────────────────────────────────────────

find "$BACKUP_DIR" -name "zimra_pos_*.sql.gz.enc" \
  -mtime "+${LOCAL_RETENTION_DAYS}" \
  -delete

echo "[$(date -u +%T)] Local backups older than ${LOCAL_RETENTION_DAYS} days removed."

# ─── Prune old S3 backups ─────────────────────────────────────────────────────
# List all backup objects, delete those older than S3_RETENTION_DAYS

CUTOFF_DATE=$(date -u -d "${S3_RETENTION_DAYS} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
  || date -u -v-"${S3_RETENTION_DAYS}"d +"%Y-%m-%dT%H:%M:%SZ")  # BSD date (macOS)

AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
aws s3api list-objects-v2 \
  --bucket "$BACKUP_S3_BUCKET" \
  --prefix "backups/zimra_pos_" \
  --endpoint-url "$BACKUP_S3_ENDPOINT" \
  --query "Contents[?LastModified<='${CUTOFF_DATE}'].Key" \
  --output text \
| tr '\t' '\n' \
| while read -r key; do
    if [ -n "$key" ] && [ "$key" != "None" ]; then
      echo "[$(date -u +%T)] Deleting old S3 backup: $key"
      AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
      AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
      aws s3api delete-object \
        --bucket "$BACKUP_S3_BUCKET" \
        --key "$key" \
        --endpoint-url "$BACKUP_S3_ENDPOINT"
    fi
  done

echo "[$(date -u +%T)] S3 backups older than ${S3_RETENTION_DAYS} days removed."

# ─── Done ─────────────────────────────────────────────────────────────────────

echo "[$(date -u +%T)] ✓ Backup complete: $BACKUP_FILENAME ($BACKUP_SIZE)"
echo "---"


# =============================================================================
# RESTORE INSTRUCTIONS (in case of emergency)
# =============================================================================
# 1. Download the backup file from S3/R2:
#      aws s3 cp s3://zimra-pos-backups/backups/zimra_pos_YYYYMMDD_HHMMSS.sql.gz.enc \
#        ./restore.sql.gz.enc --endpoint-url $BACKUP_S3_ENDPOINT
#
# 2. Decrypt and decompress:
#      openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
#        -pass "pass:$BACKUP_ENCRYPTION_KEY" \
#        -in restore.sql.gz.enc \
#      | gunzip > restore.sql
#
# 3. Restore to a fresh Supabase project (or the same one after confirming):
#      psql "$DIRECT_URL" < restore.sql
#
# 4. Re-run Prisma migrations to ensure schema is current:
#      npx prisma migrate deploy
# =============================================================================