"""Generate docs/dive-runtime.svg: how the Dive works (engines, duckling resize, refresh).

Same visual language as docs/architecture.svg (MotherDuck style): cream canvas, column
panels, white or brand-coloured boxes with a 2 px charcoal outline and an offset shadow,
mono uppercase titles. Run:  python3 docs/diagrams/dive_runtime.py
Then render the PNG:         node docs/diagrams/render_png.mjs docs/dive-runtime.svg docs/dive-runtime.png
"""
from html import escape
from pathlib import Path

INK = "#383838"
CANVAS = "#F4EFEA"
COLUMN = "#ECE6DF"
WHITE = "#FFFFFF"
YELLOW = "#FFDE00"  # S3 Tables / Iceberg
BLUE = "#6FC2FF"  # MotherDuck compute
SKY = "#97D4FF"  # Flights
TEAL = "#50C7B7"  # the Dive
CORAL = "#FF9A94"  # proposed / not built yet
MONO = "Cousine, 'JetBrains Mono', Menlo, monospace"
SANS = "Inter, Helvetica, Arial, sans-serif"

W, H = 1200, 900
out: list[str] = []


def text(x, y, s, size=14, mono=False, weight=None, anchor="start", fill=INK):
    w = f' font-weight="{weight}"' if weight else ""
    out.append(
        f'<text x="{x}" y="{y}" font-size="{size}" font-family="{MONO if mono else SANS}"{w} '
        f'text-anchor="{anchor}" fill="{fill}">{escape(s)}</text>'
    )


def lines(x, y, rows, size=14, mono=False, gap=19):
    for i, r in enumerate(rows):
        text(x, y + i * gap, r, size=size, mono=mono)


def box(x, y, w, h, title, rows, fill=WHITE, dashed=False, shadow=True, title_size=16, mono_rows=False):
    if shadow and not dashed:
        out.append(f'<rect x="{x - 8}" y="{y + 8}" width="{w}" height="{h}" rx="14" fill="{INK}"/>')
    dash = ' stroke-dasharray="8 6"' if dashed else ""
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="{INK}" stroke-width="2"{dash}/>')
    text(x + 16, y + 27, title, size=title_size, mono=True)
    lines(x + 16, y + 50, rows, mono=mono_rows)


def column(x, w, label):
    out.append(f'<rect x="{x}" y="112" width="{w}" height="640" rx="14" fill="{COLUMN}"/>')
    text(x + 22, 100, label, size=16, mono=True)


def arrow(points, label=None, lx=None, ly=None, dashed=False, both=False, anchor="start"):
    d = " ".join(f"{'M' if i == 0 else 'L'}{px},{py}" for i, (px, py) in enumerate(points))
    dash = ' stroke-dasharray="8 6"' if dashed else ""
    start = ' marker-start="url(#ah-s)"' if both else ""
    out.append(f'<path d="{d}" fill="none" stroke="{INK}" stroke-width="2"{dash}{start} marker-end="url(#ah)"/>')
    if label:
        rows = label.split("\n")
        for i, r in enumerate(rows):
            # small canvas-coloured plate behind the label keeps it readable over lines
            tw = len(r) * 7.2 + 8
            bx = lx - 4 if anchor == "start" else lx - tw / 2 if anchor == "middle" else lx - tw + 4
            out.append(f'<rect x="{bx}" y="{ly + i * 17 - 13}" width="{tw}" height="17" fill="{COLUMN}"/>')
            text(lx, ly + i * 17, r, size=13, anchor=anchor)


out.append(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
    '<defs>'
    f'<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{INK}"/></marker>'
    f'<marker id="ah-s" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="{INK}"/></marker>'
    '</defs>'
    f'<rect width="{W}" height="{H}" fill="{CANVAS}"/>'
)

text(W / 2, 46, "HOW THE DIVE WORKS", size=28, mono=True, anchor="middle")
text(W / 2, 72, "Two engines, one component · resizing the Duckling from the Dive · keeping the browser copy fresh", size=16, anchor="middle")

# ── columns ───────────────────────────────────────────────────────────────
column(20, 360, "YOUR BROWSER")
column(420, 380, "MOTHERDUCK")
column(840, 340, "AWS · us-east-1")

# ── browser: the Dive and what lives inside it ──────────────────────────────
out.append(f'<rect x="36" y="140" width="320" height="596" rx="14" fill="{INK}"/>')
out.append(f'<rect x="44" y="132" width="320" height="596" rx="14" fill="{TEAL}" stroke="{INK}" stroke-width="2"/>')
text(60, 160, "DIVE", size=18, mono=True)
lines(60, 182, ["app.motherduck.com · one React component", "useSQLQuery · useRunFlight · useFlightRun"])
box(60, 226, 288, 112, "RIGHT RAIL", ["engine toggle · duckling card", "what just ran: per-query latency,", "where it ran, the generated SQL"], shadow=False, title_size=14)
box(60, 354, 288, 92, "CLOUD MODE", ["every panel is one SQL round trip", "0.9-1.7 s per interaction"], shadow=False, title_size=14)
box(60, 462, 288, 128, "BROWSER MODE · DUCKDB-WASM", ["temp.main.daily_topics, top_stories", "84k rows, 10 chunks, dual execution", "same SQL runs in the tab", "80-155 ms per interaction"], shadow=False, title_size=14)
box(60, 606, 288, 108, "REFRESH (not built yet)", ["every N min: cheap freshness query", "changed? CREATE OR REPLACE TEMP", "TABLE per chunk, panels follow"], fill=WHITE, dashed=True, shadow=False, title_size=14)

# ── MotherDuck ──────────────────────────────────────────────────────────────
box(444, 140, 330, 100, "FLIGHT · duckling-resize", ["config SIZE · F4 runner · ~5 s", "reads the config, sends it back", "with the new read_write size"], fill=SKY)
box(444, 276, 330, 84, "ADMIN REST API", ["GET / PUT /v1/users/{user}/instances", "the Flight's own token is enough"], mono_rows=False)
box(444, 396, 330, 140, "DUCKLING · read_write", ["Pulse · Standard · Jumbo · Mega · Giga", "runs the cloud SQL and the copy", "md_live_duckling_size() = live size", "new size on the next wake-up"], fill=BLUE)
box(444, 584, 330, 144, "FLIGHT · hn-lakehouse-transform", ["on demand today; add a cron", "new titles through prompt_jev()", "rebuilds daily_topics, top_stories", "idempotent, safe to re-run"], fill=SKY)

# ── AWS ────────────────────────────────────────────────────────────────────
box(864, 140, 296, 120, "NEW DATA · sql/05", ["append from MotherDuck's public", "hacker_news share to hn.items,", "500k ids per commit; re-run"], fill=WHITE)
box(864, 396, 296, 332, "S3 TABLES · ICEBERG", ["bucket mure-lakehouse · ns hn", "", "items · 50.5M", "stories · 4.8M", "stories_classified · 567k", "daily_topics · 65k", "top_stories · 19k", "", "daily_topics + top_stories are", "the Dive's serving tables"], fill=YELLOW)

def badge(x, y, n):
    out.append(f'<circle cx="{x}" cy="{y}" r="11" fill="{INK}"/>')
    text(x, y + 4.5, str(n), size=13, mono=True, weight="bold", anchor="middle", fill=WHITE)


# ── flows ──────────────────────────────────────────────────────────────────
# 1 cloud mode
arrow([(348, 412), (444, 412)])
badge(396, 412, 1)
arrow([(774, 450), (864, 450)], "reads", 798, 442, both=True)
# 2 browser mode: copy once
arrow([(444, 505), (396, 505), (396, 540), (348, 540)], dashed=True)
badge(372, 540, 2)
# 3 resize: run the Flight, it PUTs the size, the Dive polls the live size
arrow([(348, 250), (392, 250), (392, 190), (444, 190)])
badge(392, 220, 3)
arrow([(609, 240), (609, 276)], "GET + PUT", 618, 263)
arrow([(609, 360), (609, 396)], "new size", 618, 383)
arrow([(470, 396), (470, 380), (380, 380), (380, 320), (348, 320)], dashed=True)
badge(380, 350, 3)
# 4 refresh
arrow([(348, 660), (424, 660), (424, 520), (444, 520)], dashed=True)
badge(386, 660, 4)
arrow([(774, 656), (864, 656)], "rebuilds", 790, 648)
arrow([(1012, 260), (1012, 396)], "append", 1020, 334)

# ── footer ────────────────────────────────────────────────────────────────
lines(22, 792, [
    "(1) cloud: every interaction is SQL to the Duckling, which reads Iceberg.   (2) browser: dual execution copies the serving tables once: MotherDuck scans Iceberg, rows stream into DuckDB-Wasm.",
    "(3) resize: the Dive runs duckling-resize, which PUTs the size via the admin API; the Dive polls md_live_duckling_size() every 3 s until it matches.",
    "(4) refresh: a cron on the transform Flight updates Iceberg; the Dive checks max(month), count(*) and re-copies. Dashed = not built yet.",
    "Dive sandbox (checked 17 Nov 2026): CREATE [OR REPLACE] TEMP TABLE runs; INSERT, DELETE and DROP are rejected, so a refresh replaces whole chunks.",
], size=13, gap=21)

out.append("</svg>")
dest = Path(__file__).resolve().parents[1] / "dive-runtime.svg"
dest.write_text("\n".join(out))
print(dest)
