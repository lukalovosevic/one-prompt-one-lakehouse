"""
hn-lakehouse-transform — the transformation layer of the demo lakehouse.

Runs on MotherDuck Flights (serverless Python). Reads and writes Apache Iceberg
tables in the S3 Tables catalog that MotherDuck exposes as the `lakehouse`
database. Every step is idempotent, so the Flight can run on demand or on a cron.

  1. stories             rebuild: live stories only, derived columns
  2. stories_classified  incremental: classify titles not yet classified with
                         prompt_jev() (TypeSafe Jev), in bounded batches
  3. daily_topics        rebuild: day x topic aggregate (serving table for the Dive)
  4. top_stories         rebuild: stories with 100+ points (serving table for the Dive)

Config (non-secret env vars):
  DB          MotherDuck database alias of the Iceberg catalog   (default: lakehouse)
  SCHEMA      Iceberg namespace                                   (default: hn)
  MIN_SCORE   classify stories with at least this many points    (default: 20)
  BATCH_ROWS  titles per prompt_jev INSERT batch                  (default: 50000)
  MAX_BATCHES stop after this many batches, 0 = all              (default: 0)
  SKIP_STORIES  "1" to skip step 1 (when items has not changed)  (default: 0)
"""
import os
import time

import duckdb

TOPICS = [
    "AI & machine learning",
    "Databases & data engineering",
    "Programming languages & tools",
    "Security & privacy",
    "Hardware & devices",
    "Startups, business & finance",
    "Science & space",
    "Society, politics & law",
    "Web, apps & consumer tech",
    "Other",
]


def env(name, default):
    return os.environ.get(name, default)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def timed(con, label, sql):
    t0 = time.time()
    res = con.execute(sql)
    rows = res.fetchall() if res.description else None
    log(f"{label}: {time.time() - t0:.1f}s" + (f" -> {rows[0]}" if rows else ""))
    return rows


def main():
    db = env("DB", "lakehouse")
    schema = env("SCHEMA", "hn")
    min_score = int(env("MIN_SCORE", "20"))
    batch_rows = int(env("BATCH_ROWS", "50000"))
    max_batches = int(env("MAX_BATCHES", "0"))
    skip_stories = env("SKIP_STORIES", "0") == "1"
    T = f'"{db}"."{schema}"'

    con = duckdb.connect("md:")
    log(f"connected; target {T}; duckdb {duckdb.__version__}")
    timed(con, "items", f"SELECT count(*) FROM {T}.items")

    # ── 1. stories ──────────────────────────────────────────────────────────
    if not skip_stories:
        con.execute(f"DROP TABLE IF EXISTS {T}.stories")
        timed(con, "stories rebuilt", f"""
            CREATE TABLE {T}.stories AS
            SELECT id, "by", time, title, url, score, descendants,
                   regexp_extract(url, '^https?://(?:www\\.)?([^/]+)', 1) AS domain,
                   year(time) AS yr,
                   date_trunc('month', time)::DATE AS month,
                   starts_with(title, 'Show HN') AS is_show_hn,
                   starts_with(title, 'Ask HN') AS is_ask_hn
            FROM {T}.items
            WHERE type = 'story' AND title IS NOT NULL
              AND NOT coalesce(dead, false) AND NOT coalesce(deleted, false)
        """)
        timed(con, "stories", f"SELECT count(*) FROM {T}.stories")

    # ── 2. stories_classified (incremental) ────────────────────────────────
    con.execute(f"""
        CREATE TABLE IF NOT EXISTS {T}.stories_classified AS
        SELECT s.*, ''::VARCHAR AS topic, 0.0::DOUBLE AS confidence
        FROM {T}.stories s WHERE false
    """)
    choice = ", ".join(f"'{t}'" for t in TOPICS)
    pending = timed(con, "titles to classify", f"""
        SELECT count(*) FROM {T}.stories s
        WHERE s.score >= {min_score}
          AND NOT EXISTS (SELECT 1 FROM {T}.stories_classified c WHERE c.id = s.id)
    """)[0][0]
    batches = 0
    classified = 0
    while pending > 0 and (max_batches == 0 or batches < max_batches):
        t0 = time.time()
        # Deterministic batch: lowest unclassified ids first, so a crashed run resumes cleanly.
        con.execute(f"""
            INSERT INTO {T}.stories_classified
            WITH batch AS (
                SELECT s.* FROM {T}.stories s
                WHERE s.score >= {min_score}
                  AND NOT EXISTS (SELECT 1 FROM {T}.stories_classified c WHERE c.id = s.id)
                ORDER BY s.id
                LIMIT {batch_rows}
            ),
            cls AS MATERIALIZED (
                SELECT batch.*,
                       prompt_jev(title,
                                  'Classify the main topic of this Hacker News story title',
                                  choice := [{choice}],
                                  batch_size := 64) AS c
                FROM batch
            )
            SELECT * EXCLUDE (c), c.choice AS topic, c.confidence AS confidence FROM cls
        """)
        n = min(batch_rows, pending)
        classified += n
        pending -= n
        batches += 1
        dt = time.time() - t0
        log(f"batch {batches}: {n} titles in {dt:.1f}s ({n / max(dt, 0.1):.0f} titles/s), {pending} left")
    log(f"classified {classified} titles in {batches} batches")
    timed(con, "stories_classified", f"SELECT count(*) FROM {T}.stories_classified")

    # ── 3./4. serving tables for the Dive ─────────────────────────────────
    con.execute(f"DROP TABLE IF EXISTS {T}.daily_topics")
    timed(con, "daily_topics rebuilt", f"""
        CREATE TABLE {T}.daily_topics AS
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
        FROM {T}.stories_classified
        GROUP BY ALL
    """)
    # Top 100 per (year, topic): any whole-year range x topic filter in the Dive
    # draws its top-8 from this set, and it stays small enough (~17k rows) to copy
    # into the browser in a couple of seconds.
    con.execute(f"DROP TABLE IF EXISTS {T}.top_stories")
    timed(con, "top_stories rebuilt", f"""
        CREATE TABLE {T}.top_stories AS
        SELECT id, title, url, domain, time::DATE AS d, yr, score,
               coalesce(descendants, 0) AS comments, topic, confidence
        FROM (
            SELECT *, row_number() OVER (PARTITION BY yr, topic ORDER BY score DESC, id) AS rn
            FROM {T}.stories_classified
        )
        WHERE rn <= 100
    """)
    timed(con, "serving rows", f"""
        SELECT (SELECT count(*) FROM {T}.daily_topics) AS daily_topics,
               (SELECT count(*) FROM {T}.top_stories) AS top_stories
    """)
    log("done")


if __name__ == "__main__":
    main()
