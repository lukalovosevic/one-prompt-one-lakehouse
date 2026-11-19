# The prompt that rebuilds the lakehouse

The talk shows a condensed version of this prompt on the "stack the agent builds" slide.
It is a reconstruction: the real build took several sessions of back and forth in Claude Code.
This version folds in everything those sessions learned, so one run should get from an empty AWS
account and an empty MotherDuck account to the running solution: the Iceberg tables, the
Flights and the Dive. It doesn't cover the slides, the README or the diagrams.

It has not been run end to end in one go. If you already have a copy of the demo, change the
namespace (`hn` → `hn_rebuild`) and the Dive title so the run doesn't overwrite it.

Tools: Claude Code with the MotherDuck MCP server, the AWS CLI (an SSO profile that can create
S3 Tables buckets and IAM users) and the DuckDB CLI. `MOTHERDUCK_TOKEN` lives in `.env`.

---

```text
Build a Hacker News lakehouse on Apache Iceberg in AWS us-east-1, with MotherDuck as the engine.
Use the AWS CLI with my SSO profile, the MotherDuck MCP server for SQL, Flights and Dives, and the
DuckDB CLI only where a local process is needed. MOTHERDUCK_TOKEN is in .env: load it into the
environment, never print it, never write it anywhere else, never paste a secret into a chat or a file.
Narrate each step in one line, check it with a row count or a listing before moving on, and if a
step fails, fix that step and retry it instead of changing the approach.

1. AWS
   - S3 Tables table bucket `mure-lakehouse` with namespace `hn`.
   - A plain S3 bucket `mure-lakehouse-raw-<account id>` for raw files.
   - An IAM user `motherduck-mure-demo` with an inline policy: s3tables:* on the table bucket and
     its tables, s3tables:ListTableBuckets, and read/write/list on the raw bucket only.
     Flights and Dives run unattended, so they need a key that outlives an SSO session.

2. Raw data
   - Download the 39 Parquet files of the Hugging Face dataset OpenPipe/hacker-news (about 11 GB,
     items to Oct 2024) to data/raw/ with resumable curl, then `aws s3 sync` them to
     s3://<raw bucket>/hn/. Don't read Hugging Face directly from MotherDuck: 39 parallel reads
     get HTTP 429.

3. Connect MotherDuck to the catalog
   - Mint an access key for the IAM user and pipe it straight into
     CREATE SECRET mure_s3tables IN MOTHERDUCK (TYPE S3, KEY_ID …, SECRET …, REGION 'us-east-1')
     without the key touching disk. Delete older keys first (IAM allows two).
   - CREATE DATABASE lakehouse (TYPE ICEBERG, endpoint_type 's3_tables',
     warehouse '<table bucket ARN>', "secret" mure_s3tables, default_schema 'hn').

4. Land
   - One CTAS in MotherDuck: lakehouse.hn.items from read_parquet('s3://<raw bucket>/hn/*.parquet'),
     columns id, type, "by", time, title, text, url, score, parent, top_level_parent, descendants,
     deleted, dead. Expect about 41.8M rows in about 4 minutes.
   - Then bring it up to date from MotherDuck's public share:
     ATTACH 'md:_share/hacker_news/daa0cc99-d20c-4f5c-abd5-f7b22a1a1da9' AS hacker_news;
     Append every id above max(id) in chunks of 500K ids, one INSERT (one Iceberg commit) per chunk,
     so a stopped run resumes cleanly. Map "timestamp" to time. The share has no top_level_parent:
     compute it with a recursive walk up the parent chain inside the chunk, and for chains that
     leave the chunk, look up top_level_parent of the outside parent in items.
     Expect about 8.7M new rows in about 18 commits.

5. Transform: a Flight `hn-lakehouse-transform` (Python, duckdb, connects to md:), idempotent:
   a. stories: DROP then CREATE (Iceberg has no CREATE OR REPLACE) from items: type = 'story',
      title not null, not dead or deleted; add domain (from url, without www.), yr, month,
      is_show_hn, is_ask_hn.
   b. stories_classified: incremental. Stories with score >= 20 that are not classified yet,
      lowest ids first, 50,000 per INSERT, with
      prompt_jev(title, 'Classify the main topic of this Hacker News story title',
                 choice := [10 topics], batch_size := 64)
      Topics: AI & machine learning; Databases & data engineering; Programming languages & tools;
      Security & privacy; Hardware & devices; Startups, business & finance; Science & space;
      Society, politics & law; Web, apps & consumer tech; Other.
      Store c.choice as topic and c.confidence as confidence. Config via env: MIN_SCORE,
      BATCH_ROWS, MAX_BATCHES, SKIP_STORIES.
   c. daily_topics: day x topic with stories, score, comments, plus the same three measures for
      50+, 100+ and 300+ points, so the Dive's min-points control is a column choice.
   d. top_stories: top 100 per (year, topic) by score.
   Run it until nothing is left to classify and report titles per second.

6. A second Flight `duckling-resize` (config SIZE: pulse | standard | jumbo | mega | giga) that
   reads the owner's instance config from the MotherDuck admin REST API and PUTs it back with the
   new read_write size, leaving read_scaling unchanged.

7. The Dive "Hacker News lakehouse — Iceberg on S3 Tables", every panel SQL on lakehouse.hn:
   - A month range slider with a sparkline; Monthly / Quarterly / Yearly; Stories / Share %;
     min points 20 / 50 / 100 / 300; topic chips.
   - KPIs (stories, points, comments, share about AI), stories per month by topic (stacked area),
     stories by topic (click a bar to select it), top stories by points or by comments.
   - A dark right-hand pane, hidden behind a "what just ran" tab on the right edge and pinnable
     with P: the engine toggle, the Duckling size with a resize control that runs duckling-resize,
     and every query of the last interaction with its SQL, where it ran and its latency.
   - Engine toggle MotherDuck / DuckDB-Wasm: browser mode copies daily_topics and top_stories
     once into DuckDB-Wasm temp tables with CREATE TEMP TABLE … AS SELECT (dual execution:
     MotherDuck scans Iceberg, the tab writes the rows), then runs the identical SQL locally.
   Limits to design around: iceberg_* functions don't run inside a Dive, so use plain tables only;
   an open Dive briefly errors while the Flight DROPs and re-CREATEs a serving table.

8. Report: row counts of the five tables, the Flight run times, the Dive URL, and one query timed
   three ways: MotherDuck, laptop DuckDB attached to the same catalog, and the Dive in browser mode.
```

---

## What a successful run leaves behind (18 Nov 2026)

| Object | Expected |
|---|---|
| lakehouse.hn.items | 50.5M rows, 2006 → 15 Nov 2026 |
| lakehouse.hn.stories | 4.8M |
| lakehouse.hn.stories_classified | 567K |
| lakehouse.hn.daily_topics | 65K |
| lakehouse.hn.top_stories | 19K |
| Flights | hn-lakehouse-transform, duckling-resize |
| Dive | cloud ≈ 1 s per interaction, browser ≈ 0.1 s after a ≈ 4 s copy of 84K rows |

The repo holds the hand-written equivalents of each step: `scripts/00`–`03`, `sql/05`,
`flights/hn_transform.py`, `flights/duckling_resize.py` and `dive/dive.tsx`.
