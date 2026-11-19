#!/usr/bin/env bash
# Waits for scripts/00 to finish (39 files present and curl gone), then syncs data/raw to the S3 raw zone.
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_PROFILE="${AWS_PROFILE:-default}" AWS_DEFAULT_REGION=us-east-1
while pgrep -f 00_download_hn_raw.sh >/dev/null; do sleep 30; done
n=$(ls data/raw/*.parquet 2>/dev/null | wc -l | tr -d ' ')
echo "[$(date +%H:%M:%S)] download finished with $n files; syncing"
RAW_BUCKET="${RAW_BUCKET:-mure-lakehouse-raw-$(aws sts get-caller-identity --query Account --output text)}"
aws s3 sync data/raw "s3://$RAW_BUCKET/hn/" --only-show-errors
aws s3 ls "s3://$RAW_BUCKET/hn/" --summarize --human-readable | tail -2
