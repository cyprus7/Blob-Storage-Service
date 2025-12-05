#!/usr/bin/env bash
set -euo pipefail

# init-dev.sh
# Bootstraps local dev environment:
# - ensures .env.local exists (copies from .env.example)
# - starts postgres and minio
# - waits for postgres and minio readiness
# - creates S3 bucket
# - applies SQL migration
# - starts blob-service

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[init-dev] Starting initialization in $ROOT_DIR"

if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    echo "[init-dev] .env.local not found — copying from .env.example"
    cp .env.example .env.local
  else
    echo "[init-dev] ERROR: .env.example not found. Create .env.local manually." >&2
    exit 1
  fi
else
  echo "[init-dev] Using existing .env.local"
fi

# Load env into current shell
set -a
source .env.local
set +a

NETWORK="$(basename "$PWD")_default"
echo "[init-dev] Using docker network: $NETWORK"

echo "[init-dev] Starting postgres and minio..."
docker compose up -d postgres minio

echo "[init-dev] Waiting for Postgres to be ready..."
POSTGRES_CONTAINER=$(docker compose ps -q postgres)
if [ -z "$POSTGRES_CONTAINER" ]; then
  echo "[init-dev] ERROR: postgres container not found" >&2
  exit 1
fi

until docker exec -u postgres "$POSTGRES_CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  printf '.'
  sleep 1
done
echo "\n[init-dev] Postgres is ready"

echo "[init-dev] Waiting for MinIO to be responsive..."
# Try to contact MinIO API from within the network using aws-cli or curl via alpine container
MAX_RETRIES=60
count=0
while ! docker run --rm --network "$NETWORK" curlimages/curl:7.88.1 -sSf "${S3_ENDPOINT%/}/minio/health/ready" >/dev/null 2>&1; do
  count=$((count+1))
  if [ $count -ge $MAX_RETRIES ]; then
    echo "[init-dev] ERROR: MinIO did not become ready in time" >&2
    exit 1
  fi
  printf '.'
  sleep 1
done
echo "\n[init-dev] MinIO is ready"

echo "[init-dev] Creating S3 bucket '$S3_BUCKET' (idempotent)"
docker run --rm --network "$NETWORK" -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" amazon/aws-cli:latest s3api create-bucket --bucket "$S3_BUCKET" --endpoint-url "$S3_ENDPOINT" --region "$S3_REGION" || true

echo "[init-dev] Applying SQL migrations"
if [ -f migrations/blob-service/0000_curious_piledriver.sql ]; then
  docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f - < migrations/blob-service/0000_curious_piledriver.sql || true
  echo "[init-dev] Migration applied (or already present)"
else
  echo "[init-dev] No migration file found at migrations/blob-service/0000_curious_piledriver.sql" >&2
fi

echo "[init-dev] Starting blob-service"
docker compose up -d blob-service

echo "[init-dev] Done. blob-service should be reachable at http://localhost:${PORT:-3100}"
