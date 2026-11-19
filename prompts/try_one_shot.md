# One shot on motherduck.com/try

The opening demo of the talk: one prompt on [motherduck.com/try](https://motherduck.com/try), a free
AI chat in a temporary MotherDuck org, goes from Iceberg files to a Dive. No login, no catalog, no keys.

It reads catalog-less Iceberg copies of the two serving tables (`daily_topics`, `top_stories`) from a
public bucket that allows anonymous `s3:GetObject` and nothing else. The bucket used in the talk has
been removed; to run this yourself, write the two tables to your own public bucket and replace
`<your-public-bucket>`. `iceberg_scan` finds the current metadata through `version-hint.text`.

```text
Two public Apache Iceberg tables on S3 (us-east-1) hold Hacker News stories with 20+ points, 2007 to
Oct 2024, each classified into one of 10 topics:
iceberg_scan('s3://<your-public-bucket>/hn/daily_topics') has one row per day and topic
(d, month, yr, topic, stories, score, comments);
iceberg_scan('s3://<your-public-bucket>/hn/top_stories') has the best stories per year and topic
(title, url, domain, d, yr, score, comments, topic).
Build a Dive that shows how Hacker News topics changed over time: stories per month by topic, and the
top stories for a topic I pick. Read only these two paths: the bucket does not allow listing, so do not
try to list or glob it. Every chart query aggregates in SQL. If a query fails, fix that query and retry
instead of changing approach.
```

If the chat reports missing S3 credentials, add one line to the prompt:
`First run CREATE SECRET (TYPE s3, KEY_ID '', SECRET '', REGION 'us-east-1').`
