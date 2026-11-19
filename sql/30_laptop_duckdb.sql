-- Same Iceberg tables, read directly from a laptop with plain DuckDB.
--   duckdb -init sql/30_laptop_duckdb.sql
-- Needs: AWS credentials in the environment (e.g. aws sso login --profile <your-aws-profile>;
-- export AWS_PROFILE=<your-aws-profile>) and the iceberg + httpfs extensions.
INSTALL iceberg; LOAD iceberg;
INSTALL httpfs;  LOAD httpfs;
CREATE OR REPLACE SECRET aws (TYPE s3, PROVIDER credential_chain, REGION 'us-east-1');

-- Replace the ARN with the one printed by scripts/01.
ATTACH 'arn:aws:s3tables:us-east-1:<account-id>:bucket/mure-lakehouse' AS lakehouse (
    TYPE iceberg,
    ENDPOINT_TYPE s3_tables
);

.timer on
SHOW ALL TABLES;

-- Q1: metadata only (fast anywhere)
SELECT count(*) FROM lakehouse.hn.items;

-- Q2: stories per year by topic (scans ~1M rows)
SELECT yr, topic, count(*) n
FROM lakehouse.hn.stories_classified
GROUP BY ALL ORDER BY 1, 3 DESC;

-- Q3: the heavy one, full scan of 42M rows with a string filter
SELECT year(time) yr, count(*) mentions
FROM lakehouse.hn.items
WHERE text ILIKE '%duckdb%' OR title ILIKE '%duckdb%'
GROUP BY 1 ORDER BY 1;
