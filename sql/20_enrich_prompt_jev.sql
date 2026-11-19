-- NOTE: superseded by the Flight `hn-lakehouse-transform` (flights/hn_transform.py), which runs the
-- same classification incrementally in 50k-title batches. Kept as the single-statement equivalent.
-- Needs DuckDB CLI >= 1.5.6 (older MotherDuck extensions do not register prompt_jev client-side).
-- AI enrichment with prompt_jev() (TypeSafe Jev: calibrated classification, not prose).
-- Classifies every live story with score >= 20 into one of 10 topics. Single-question
-- mode batches titles per request (~260k titles per AI unit at ~50 chars).
-- The result is written back to Iceberg, so laptop DuckDB, MotherDuck and the
-- browser all read the same enriched table.

DROP TABLE IF EXISTS lakehouse.hn.stories_classified;
CREATE TABLE lakehouse.hn.stories_classified AS
WITH src AS (
    SELECT * FROM lakehouse.hn.stories WHERE score >= 20
),
cls AS (
    SELECT
        src.*,
        prompt_jev(
            title,
            'Classify the main topic of this Hacker News story title',
            choice := [
                'AI & machine learning',
                'Databases & data engineering',
                'Programming languages & tools',
                'Security & privacy',
                'Hardware & devices',
                'Startups, business & finance',
                'Science & space',
                'Society, politics & law',
                'Web, apps & consumer tech',
                'Other'
            ],
            batch_size := 64
        ) AS c
    FROM src
)
SELECT * EXCLUDE (c), c.choice AS topic, c.confidence AS confidence
FROM cls;

SELECT topic, count(*) n, round(avg(confidence), 2) avg_conf
FROM lakehouse.hn.stories_classified GROUP BY 1 ORDER BY 2 DESC;

-- Serving tables for the Dive (small, so the browser can cache them whole).
DROP TABLE IF EXISTS lakehouse.hn.daily_topics;
CREATE TABLE lakehouse.hn.daily_topics AS
SELECT time::DATE AS d, yr, month, topic,
       count(*) AS stories, sum(score) AS score, sum(coalesce(descendants, 0)) AS comments,
       -- the same three measures at higher point thresholds, so a "min points"
       -- control in the Dive is a column choice rather than a wider table
       count(*) FILTER (WHERE score >= 50)  AS stories_ge50,
       sum(score) FILTER (WHERE score >= 50) AS score_ge50,
       sum(coalesce(descendants, 0)) FILTER (WHERE score >= 50) AS comments_ge50,
       count(*) FILTER (WHERE score >= 100) AS stories_ge100,
       sum(score) FILTER (WHERE score >= 100) AS score_ge100,
       sum(coalesce(descendants, 0)) FILTER (WHERE score >= 100) AS comments_ge100,
       count(*) FILTER (WHERE score >= 300) AS stories_ge300,
       sum(score) FILTER (WHERE score >= 300) AS score_ge300,
       sum(coalesce(descendants, 0)) FILTER (WHERE score >= 300) AS comments_ge300
FROM lakehouse.hn.stories_classified
GROUP BY ALL;

DROP TABLE IF EXISTS lakehouse.hn.top_stories;
CREATE TABLE lakehouse.hn.top_stories AS
SELECT id, title, url, domain, time::DATE AS d, yr, score, coalesce(descendants, 0) AS comments, topic, confidence
FROM (SELECT *, row_number() OVER (PARTITION BY yr, topic ORDER BY score DESC, id) AS rn FROM lakehouse.hn.stories_classified)
WHERE rn <= 100;

SELECT (SELECT count(*) FROM lakehouse.hn.daily_topics) AS daily_rows,
       (SELECT count(*) FROM lakehouse.hn.top_stories) AS top_rows;
