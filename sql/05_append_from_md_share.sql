-- Append newer Hacker News items to lakehouse.hn.items from MotherDuck's public
-- hacker_news share (refreshed daily from BigQuery, ~1-2 days behind HN).
--
-- One run appends the next 500,000 ids after max(id) already in Iceberg, as ONE
-- Iceberg commit. Re-run until it inserts 0 rows. Because every run starts at
-- max(id) and commits atomically, stopping at any point leaves the table complete
-- up to some id: no gaps, no duplicates. Re-running later picks up new items, so
-- this is also the "new items into Iceberg" refresh step.
--
-- Needs the share attached once (us-east-1 only):
--   ATTACH 'md:_share/hacker_news/daa0cc99-d20c-4f5c-abd5-f7b22a1a1da9' AS hacker_news;
--
-- Mapping to the items schema (which came from the OpenPipe dump):
--   time              <- "timestamp" (the share's time column is epoch seconds)
--   top_level_parent  <- computed: the item itself for stories, jobs, polls and poll
--                        options; for comments the root story, found by walking
--                        parent links inside the chunk and then looking up the
--                        parent's top_level_parent in rows already in Iceberg.
--                        NULL when the parent is missing from the source (a few
--                        ids per 500K are absent from the share).
--   ranking           -> dropped (not in items)

INSERT INTO lakehouse.hn.items
    (id, type, "by", time, title, text, url, score, parent, top_level_parent, descendants, deleted, dead)
SELECT * FROM (
    WITH RECURSIVE
    bounds AS (SELECT max(id) AS lo, max(id) + 500000 AS hi FROM lakehouse.hn.items),
    chunk AS (
        SELECT s.id, s.type, s."by", s."timestamp" AS time, s.title, s.text, s.url, s.score,
               s.parent, s.descendants, s.deleted, s.dead
        FROM hacker_news.hacker_news s, bounds b
        WHERE s.id > b.lo AND s.id <= b.hi
    ),
    walk AS (                       -- climb comment -> parent while the parent is in this chunk
        SELECT id, id AS cur, 0 AS depth FROM chunk
        UNION ALL
        SELECT w.id, c.parent, w.depth + 1
        FROM walk w
        JOIN chunk c ON c.id = w.cur
        JOIN chunk p ON p.id = c.parent
        WHERE c.type = 'comment'
    ),
    tops AS (SELECT id, arg_max(cur, depth) AS top FROM walk GROUP BY id),
    resolved AS (
        SELECT t.id, r.type AS top_type, r.id AS top_id, r.parent AS ext_parent
        FROM tops t JOIN chunk r ON r.id = t.top
    ),
    ext AS (                        -- parents that are already in Iceberg
        SELECT id, top_level_parent FROM lakehouse.hn.items
        WHERE id IN (SELECT ext_parent FROM resolved WHERE top_type = 'comment')
    )
    SELECT c.id, c.type, c."by", c.time, c.title, c.text, c.url, c.score, c.parent,
           CASE WHEN rv.top_type <> 'comment' THEN rv.top_id ELSE e.top_level_parent END,
           c.descendants, c.deleted, c.dead
    FROM chunk c
    JOIN resolved rv USING (id)
    LEFT JOIN ext e ON e.id = rv.ext_parent
    ORDER BY c.id
);
