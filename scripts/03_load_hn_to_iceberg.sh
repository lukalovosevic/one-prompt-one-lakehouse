#!/usr/bin/env bash
# Step A (laptop): sync the raw parquet files to the S3 raw zone.
# Step B (MotherDuck): land them in the Iceberg table lakehouse.hn.items on S3 Tables
#         with one CTAS. MotherDuck reads s3://raw and writes Iceberg; same region,
#         nothing flows through the laptop.
#
# Requires: data/raw/ populated by scripts/00, AWS SSO login, MOTHERDUCK_TOKEN (env or .env),
#           scripts/01 and 02 already run.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] && set -a && source .env && set +a
: "${MOTHERDUCK_TOKEN:?set MOTHERDUCK_TOKEN}"
export motherduck_token="$MOTHERDUCK_TOKEN"
export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
MD_DB="${MD_DB:-lakehouse}"
RAW_BUCKET="${RAW_BUCKET:-mure-lakehouse-raw-$(aws sts get-caller-identity --query Account --output text)}"

echo "A. syncing data/raw -> s3://$RAW_BUCKET/hn/"
aws s3 sync data/raw "s3://$RAW_BUCKET/hn/" --only-show-errors
aws s3 ls "s3://$RAW_BUCKET/hn/" --summarize --human-readable | tail -2

echo "B. CTAS into Iceberg (MotherDuck)"
time duckdb <<SQL
ATTACH 'md:';
DROP TABLE IF EXISTS $MD_DB.hn.items;
CREATE TABLE $MD_DB.hn.items AS
SELECT id, type, "by", time, title, text, url, score, parent, top_level_parent, descendants,
       deleted, dead
FROM read_parquet('s3://$RAW_BUCKET/hn/*.parquet');
SELECT count(*) AS items, min(time) AS first, max(time) AS last FROM $MD_DB.hn.items;
SQL
