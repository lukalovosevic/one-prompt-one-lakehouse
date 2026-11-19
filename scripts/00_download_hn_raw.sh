#!/usr/bin/env bash
# Downloads the 39 raw parquet files (~11 GB) of OpenPipe/hacker-news from Hugging
# Face to data/raw/. Resumable; re-run to continue.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw
for i in $(seq 0 38); do
  f=$(printf 'train-%05d-of-00039.parquet' "$i")
  url="https://huggingface.co/datasets/OpenPipe/hacker-news/resolve/main/data/$f"
  curl -sSL --retry 8 --retry-all-errors --retry-delay 15 -C - -o "data/raw/$f" "$url" \
    && echo "[$(date +%H:%M:%S)] $f $(du -h "data/raw/$f" | cut -f1)"
done
ls -la data/raw | tail -3
