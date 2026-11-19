#!/usr/bin/env bash
# Mints an access key for the demo IAM user and registers it in MotherDuck as an
# S3 secret, then creates the Iceberg database pointing at the S3 Tables bucket.
# The key is passed straight from the AWS CLI into the DuckDB CLI; nothing is
# written to disk.
#
# Requires: MOTHERDUCK_TOKEN in the environment (or in ../.env), AWS SSO login.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] && set -a && source .env && set +a
: "${MOTHERDUCK_TOKEN:?set MOTHERDUCK_TOKEN (or put it in .env)}"
export motherduck_token="$MOTHERDUCK_TOKEN"

export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
BUCKET="${BUCKET:-mure-lakehouse}"
IAM_USER="${IAM_USER:-motherduck-mure-demo}"
MD_DB="${MD_DB:-lakehouse}"
MD_SECRET="${MD_SECRET:-mure_s3tables}"

ARN=$(aws s3tables list-table-buckets --query "tableBuckets[?name=='$BUCKET'].arn | [0]" --output text)
[[ "$ARN" == "None" ]] && { echo "bucket $BUCKET not found; run 01 first"; exit 1; }

# Rotate: IAM allows max 2 keys per user, so delete old ones first.
for k in $(aws iam list-access-keys --user-name "$IAM_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name "$IAM_USER" --access-key-id "$k"
done
read -r KEY_ID SECRET < <(aws iam create-access-key --user-name "$IAM_USER" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
echo "minted access key $KEY_ID for $IAM_USER (IAM keys take ~10s to propagate)"
sleep 12

duckdb <<SQL
ATTACH 'md:';
CREATE OR REPLACE SECRET $MD_SECRET IN MOTHERDUCK (
    TYPE S3,
    KEY_ID '$KEY_ID',
    SECRET '$SECRET',
    REGION '$AWS_REGION'
);
CREATE DATABASE IF NOT EXISTS $MD_DB (
    TYPE ICEBERG,
    endpoint_type 's3_tables',
    warehouse '$ARN',
    "secret" $MD_SECRET,
    default_schema 'hn'
);
SHOW DATABASES;
SQL
echo "MotherDuck database '$MD_DB' now points at $ARN"
