Local development bootstrap
=========================

This project includes a helper script `scripts/init-dev.sh` that bootstraps a local development environment.

Quick usage:

```bash
chmod +x scripts/init-dev.sh
./scripts/init-dev.sh
```

What the script does:

- Creates `.env.local` from `.env.example` if `.env.local` is missing
- Starts `postgres` and `minio` services using `docker compose`
- Waits for Postgres and MinIO readiness
- Creates the S3 bucket defined by `S3_BUCKET` (idempotent)
- Applies the SQL migration `migrations/blob-service/0000_curious_piledriver.sql`
- Starts the `blob-service`

Notes:

- The script assumes Docker is installed and `docker compose` is available.
- `.env.local` is used for service environment variables and **should not** be committed. See `.gitignore`.
- If you prefer manual control, you can start services with `docker compose up --build -d` and then create the bucket and run migrations manually.
