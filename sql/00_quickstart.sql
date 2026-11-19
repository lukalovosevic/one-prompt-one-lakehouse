-- Quickstart: query Iceberg tables in S3 Tables from MotherDuck.
-- Three statements: a secret, a database, a query.
--
-- Run them in the MotherDuck web UI, or from a terminal:
--   duckdb "md:"   then paste this file   (needs motherduck_token in the environment)
--
-- Before you start (AWS side, once):
--   * an S3 table bucket with at least one namespace (scripts/01 creates one)
--   * an IAM access key that can read it (scripts/01b creates a scoped user)
-- scripts/02_motherduck_connect.sh does steps 1 and 2 for you and keeps the key off disk.


-- 1. SECRET: store the AWS key in MotherDuck, once.
--    It lives server side, so Dives and Flights can use it without your laptop.
CREATE SECRET s3t IN MOTHERDUCK (
    TYPE S3,
    KEY_ID 'AKIA...',
    SECRET '...',
    REGION 'us-east-1'
);


-- 2. DATABASE: point MotherDuck at the table bucket.
--    This creates no tables and copies no data. It registers the catalog,
--    like an ATTACH that every session and every teammate gets.
CREATE DATABASE lakehouse (
    TYPE ICEBERG,
    endpoint_type 's3_tables',
    warehouse 'arn:aws:s3tables:us-east-1:<account-id>:bucket/mure-lakehouse',
    "secret" s3t,
    default_schema 'hn'           -- a namespace that exists in the bucket
);


-- 3. QUERY: plain SQL, database.namespace.table.
SHOW TABLES FROM lakehouse.hn;

SELECT topic, count(*) AS stories, round(avg(score), 1) AS avg_score
FROM lakehouse.hn.stories_classified
GROUP BY topic
ORDER BY stories DESC;


-- That's it. Writes work the same way (INSERT, UPDATE, DELETE, MERGE INTO,
-- CREATE TABLE AS); each one is an Iceberg commit other engines can read.
--
-- Other catalogs use the same two statements with different options:
--   AWS Glue:          endpoint_type 'glue', warehouse '<account-id>'
--   any REST catalog:  CREATE SECRET ... (TYPE ICEBERG, CLIENT_ID ..., CLIENT_SECRET ...)
--                      and endpoint 'https://...' instead of endpoint_type
-- Add read_only true to the CREATE DATABASE options to attach without write access.
--
-- To undo: DROP DATABASE lakehouse;  (removes the registration only;
-- the tables stay in S3 Tables)
