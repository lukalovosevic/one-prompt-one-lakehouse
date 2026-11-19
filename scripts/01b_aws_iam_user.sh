#!/usr/bin/env bash
# Creates the IAM user MotherDuck authenticates as, with an inline least-privilege
# policy scoped to the demo table bucket and the raw bucket. Run this yourself:
#   AWS_PROFILE=<your-aws-profile> ./scripts/01b_aws_iam_user.sh
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
BUCKET="${BUCKET:-mure-lakehouse}"
IAM_USER="${IAM_USER:-motherduck-mure-demo}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
RAW_BUCKET="${RAW_BUCKET:-mure-lakehouse-raw-$ACCOUNT_ID}"
ARN=$(aws s3tables list-table-buckets --query "tableBuckets[?name=='$BUCKET'].arn | [0]" --output text)
[[ "$ARN" == "None" ]] && { echo "table bucket $BUCKET not found; run scripts/01 first"; exit 1; }

# 3. IAM user + least-privilege policy for this one table bucket
if ! aws iam get-user --user-name "$IAM_USER" >/dev/null 2>&1; then
  aws iam create-user --user-name "$IAM_USER" >/dev/null
  echo "created IAM user $IAM_USER"
fi
POLICY_DOC=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3TablesBucket",
      "Effect": "Allow",
      "Action": ["s3tables:*"],
      "Resource": ["$ARN", "$ARN/table/*"]
    },
    {
      "Sid": "RawZone",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::$RAW_BUCKET", "arn:aws:s3:::$RAW_BUCKET/*"]
    },
    {
      "Sid": "S3TablesList",
      "Effect": "Allow",
      "Action": ["s3tables:ListTableBuckets"],
      "Resource": "*"
    }
  ]
}
JSON
)
aws iam put-user-policy --user-name "$IAM_USER" --policy-name "s3tables-$BUCKET" --policy-document "$POLICY_DOC"
echo "attached inline policy s3tables-$BUCKET"

echo "done: $IAM_USER can use $ARN and s3://$RAW_BUCKET"
echo "Next: ./scripts/02_motherduck_connect.sh"
