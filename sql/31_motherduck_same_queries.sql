-- The exact same three queries, run in MotherDuck next to the data.
--   duckdb -init sql/31_motherduck_same_queries.sql     (with motherduck_token set)
ATTACH 'md:';
.timer on

SELECT count(*) FROM lakehouse.hn.items;

SELECT yr, topic, count(*) n
FROM lakehouse.hn.stories_classified
GROUP BY ALL ORDER BY 1, 3 DESC;

SELECT year(time) yr, count(*) mentions
FROM lakehouse.hn.items
WHERE text ILIKE '%duckdb%' OR title ILIKE '%duckdb%'
GROUP BY 1 ORDER BY 1;
