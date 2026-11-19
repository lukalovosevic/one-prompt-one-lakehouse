#!/usr/bin/env bash
# Creates the S3 Tables bucket + namespace and the raw S3 bucket. Idempotent.
# IAM user/policy creation is in scripts/01b_aws_iam_user.sh (run that yourself).
#
# Usage:  AWS_PROFILE=<your-aws-profile> ./scripts/01_aws_s3tables_setup.sh
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

BUCKET="${BUCKET:-mure-lakehouse}"
NAMESPACE="${NAMESPACE:-hn}"
IAM_USER="${IAM_USER:-motherduck-mure-demo}"
RAW_BUCKET="${RAW_BUCKET:-mure-lakehouse-raw-$(aws sts get-caller-identity --query Account --output text)}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "account=$ACCOUNT_ID region=$AWS_REGION bucket=$BUCKET namespace=$NAMESPACE"

# 1. Table bucket
ARN=$(aws s3tables list-table-buckets --query "tableBuckets[?name=='$BUCKET'].arn | [0]" --output text)
if [[ "$ARN" == "None" || -z "$ARN" ]]; then
  ARN=$(aws s3tables create-table-bucket --name "$BUCKET" --query arn --output text)
  echo "created table bucket $ARN"
else
  echo "table bucket exists: $ARN"
fi

# 2. Namespace
if ! aws s3tables get-namespace --table-bucket-arn "$ARN" --namespace "$NAMESPACE" >/dev/null 2>&1; then
  aws s3tables create-namespace --table-bucket-arn "$ARN" --namespace "$NAMESPACE" >/dev/null
  echo "created namespace $NAMESPACE"
else
  echo "namespace exists: $NAMESPACE"
fi

# 2b. Plain S3 bucket for the raw landing zone
if ! aws s3api head-bucket --bucket "$RAW_BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$RAW_BUCKET" >/dev/null
  echo "created raw bucket s3://$RAW_BUCKET"
else
  echo "raw bucket exists: s3://$RAW_BUCKET"
fi

echo
echo "S3_TABLES_ARN=$ARN"
echo "RAW_BUCKET=s3://$RAW_BUCKET"
echo "Next: ./scripts/01b_aws_iam_user.sh"
