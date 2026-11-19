-- NOTE: step 1 of the Flight `hn-lakehouse-transform` does exactly this; kept as the manual equivalent.
-- Run in MotherDuck (duckdb CLI with ATTACH 'md:' or the MD UI) after scripts/03.
-- Builds the curated Iceberg tables the Dive reads. All writes land in S3 Tables.

-- Live stories only, with a few derived columns. ~5M rows.
DROP TABLE IF EXISTS lakehouse.hn.stories;
CREATE TABLE lakehouse.hn.stories AS
SELECT
    id, by, time, title, url, score, descendants,
    regexp_extract(url, '^https?://(?:www\.)?([^/]+)', 1) AS domain,
    year(time)                                           AS yr,
    date_trunc('month', time)::DATE                      AS month,
    starts_with(title, 'Show HN')                        AS is_show_hn,
    starts_with(title, 'Ask HN')                         AS is_ask_hn
FROM lakehouse.hn.items
WHERE type = 'story'
  AND title IS NOT NULL
  AND NOT coalesce(dead, false)
  AND NOT coalesce(deleted, false);

SELECT yr, count(*) stories, count(*) FILTER (WHERE score >= 20) stories_20plus
FROM lakehouse.hn.stories GROUP BY 1 ORDER BY 1;
