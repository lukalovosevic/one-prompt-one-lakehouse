import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useDiveState, useFlightRun, useRunFlight, useSQLQuery } from '@motherduck/react-sql-query';
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts';
import { Cloud, PanelRightOpen, Pin, X, Zap } from 'lucide-react';

export const REQUIRED_DATABASES = [
	{ type: 'database', path: 'md:lakehouse', alias: 'lakehouse' },
];

// ── Two engines run the same analytical SQL ───────────────────────────────
//   cloud — every query goes to MotherDuck and reads the Iceberg tables directly
//   wasm  — the two serving tables are copied once into DuckDB-Wasm temp tables
//           (in chunks, so the progress bar is real) and the SQL runs in the browser
type Engine = 'cloud' | 'wasm';
const CLOUD = `"lakehouse"."hn"`;
const LOCAL = `"temp"."main"`;

// ── Mure Data look & feel (muredata.com/brand): off-white canvas, near-black ink,
//    dark greens as the only accent, Inter for text, Roboto Mono for labels ──────
const LIGHT = {
	bg: '#f7f7f5', // Soft Quartz
	card: '#ffffff',
	panel: '#efeeea',
	border: '#ddd8d0',
	ink: '#0a0a0a', // Data Void
	sub: '#4f4d48',
	muted: '#6b6963',
	quiet: '#8a8781',
	stone: '#cacbbd', // Soft Stone
	forest: '#1e2f30', // Deep Forest (cloud engine accent)
	green: '#008060', // Tropical Rain Forest (wasm engine accent)
	emerald: '#27f795', // Emerald Ice Palace
	lime: '#b2f727', // Signal Lime
	danger: '#b42318',
	bar: '#0a0a0a', // announcement bar
	barInk: '#f7f7f5',
	shadow: 'rgba(22,30,27,.12)',
};
// The site's dark theme: near-black canvas, deep-forest surfaces, warm off-white ink.
// Accents flip to their light variants so they stay readable: cloud = Soft Stone, wasm = Emerald.
const DARK: typeof LIGHT = {
	bg: '#0a0a0a',
	card: '#111918',
	panel: '#1a2322',
	border: '#232e2d',
	ink: '#f2efe8',
	sub: '#c8c4bc',
	muted: '#9e9890',
	quiet: '#7a8a86',
	stone: '#34403e',
	forest: '#cacbbd',
	green: '#27f795',
	emerald: '#27f795',
	lime: '#b2f727',
	danger: '#ff8a75',
	bar: '#000000',
	barInk: '#f2efe8',
	shadow: 'rgba(0,0,0,.55)',
};
type Theme = 'light' | 'dark';
type ThemePref = 'auto' | Theme;
// The active palette. Set once at the top of the Dive's render (before any child renders),
// so every component below reads the current theme without threading it through props.
let M: typeof LIGHT = LIGHT;
const SANS = 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif';
const MONO = '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_CSS = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Roboto+Mono:wght@400;500&display=swap');`;
// Getters, so a spread or a style read picks up the palette of the current render.
const eyebrow = { fontFamily: MONO, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' as const, get color() { return M.muted; } };
// cloud = Deep Forest (the serious, remote engine); wasm = Emerald (the bright, local one)
const ENGINE_COLOR: Record<Engine, string> = { get cloud() { return M.forest; }, get wasm() { return M.green; } };
const ENGINE_FILL: Record<Engine, string> = { get cloud() { return M.forest; }, get wasm() { return M.emerald; } };
const darkQuery = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);
function useSystemDark(): boolean {
	return useSyncExternalStore(
		(fn) => {
			const mq = darkQuery();
			if (!mq) return () => {};
			mq.addEventListener('change', fn);
			return () => mq.removeEventListener('change', fn);
		},
		() => !!darkQuery()?.matches,
		() => false,
	);
}
// The "what just ran" rail is always dark (the site's dark theme): black, deep forest, emerald, signal lime.
const D = {
	bg: '#0a0d0d',
	card: '#111918',
	border: '#232e2d',
	rail: '#1a2322',
	ink: '#f2efe8',
	sub: '#c8c4bc',
	muted: '#9e9890',
	quiet: '#7a8a86',
	code: '#d7d3cb',
	danger: '#ff8a75',
	green: M.emerald,
	greenWash: '#0f2f24',
	cloud: M.stone,
	cloudWash: LIGHT.forest,
	lime: M.lime,
	limeWash: '#26300f',
};
type Target = Engine | 'hybrid';
const targetOf = (sql: string): Target => {
	const local = sql.includes(LOCAL);
	const remote = sql.includes(CLOUD);
	return local && remote ? 'hybrid' : local ? 'wasm' : 'cloud';
};
const TARGET_LABEL: Record<Target, string> = { cloud: 'motherduck', wasm: 'browser', hybrid: 'cloud → browser' };
const targetColor = (t: Target) => (t === 'cloud' ? D.cloud : t === 'wasm' ? D.green : D.lime);
const targetWash = (t: Target) => (t === 'cloud' ? D.cloudWash : t === 'wasm' ? D.greenWash : D.limeWash);
const tidySql = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const RAIL_W = 380;

// ── Query log: every finished statement, grouped into interactions ("bursts") ──
type QueryRecord = { id: number; label: string; sql: string; ms: number; rows: number; startedAt: number; burst: number; error?: string; tag?: string };
type LogSnapshot = { log: QueryRecord[]; burst: number };
const LOG_LIMIT = 60;
const BURST_GAP_MS = 60;
class QueryLogStore {
	private listeners = new Set<() => void>();
	private snap: LogSnapshot = { log: [], burst: 0 };
	private nextId = 1;
	private lastStart = -Infinity;
	subscribe = (fn: () => void) => {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	};
	getSnapshot = () => this.snap;
	record(e: Omit<QueryRecord, 'id' | 'burst'>) {
		let burst = this.snap.burst;
		if (!e.tag && e.startedAt > this.lastStart + BURST_GAP_MS) {
			burst += 1;
			this.lastStart = e.startedAt;
		}
		const log = [...this.snap.log, { ...e, id: this.nextId++, burst }];
		this.snap = { log: log.length > LOG_LIMIT ? log.slice(-LOG_LIMIT) : log, burst };
		this.listeners.forEach((l) => l());
	}
}
const queryLog = new QueryLogStore();
const useQueryLog = () => useSyncExternalStore(queryLog.subscribe, queryLog.getSnapshot);

// Month axis: index 0 = 2007-01 … last = 2026-11 (data runs to 15 Nov 2026)
const FIRST_MONTH = [2007, 1];
const LAST_MONTH = [2026, 11];
const MONTHS: string[] = (() => {
	const out: string[] = [];
	for (let y = FIRST_MONTH[0], m = FIRST_MONTH[1]; y < LAST_MONTH[0] || (y === LAST_MONTH[0] && m <= LAST_MONTH[1]); ) {
		out.push(`${y}-${String(m).padStart(2, '0')}`);
		m++;
		if (m > 12) { m = 1; y++; }
	}
	return out;
})();
const monthLabel = (ym: string) => {
	const [y, m] = ym.split('-');
	return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
};
const DEFAULT_RANGE: [number, number] = [MONTHS.indexOf('2015-01'), MONTHS.length - 1];

const TOPICS = [
	'AI & machine learning',
	'Databases & data engineering',
	'Programming languages & tools',
	'Security & privacy',
	'Hardware & devices',
	'Startups, business & finance',
	'Science & space',
	'Society, politics & law',
	'Web, apps & consumer tech',
	'Other',
];
// Brand green leads; the rest are validated (CVD-safe adjacent pairs, mid-lightness band). Other stays neutral.
const TOPIC_COLOR: Record<string, string> = {
	'AI & machine learning': '#008060',
	'Databases & data engineering': '#c2410c',
	'Programming languages & tools': '#3d6bff',
	'Security & privacy': '#e5483a',
	'Hardware & devices': '#22b07a',
	'Startups, business & finance': '#d98a00',
	'Science & space': '#8b5cf6',
	'Society, politics & law': '#9ab61a',
	'Web, apps & consumer tech': '#7da2ff',
	Other: '#9e9890',
};
// Light fills take dark text when used as a chip background
const LIGHT_TOPIC = new Set(['Hardware & devices', 'Startups, business & finance', 'Society, politics & law', 'Web, apps & consumer tech', 'Other']);
const SHORT: Record<string, string> = {
	'AI & machine learning': 'AI/ML',
	'Databases & data engineering': 'Data',
	'Programming languages & tools': 'Prog.',
	'Security & privacy': 'Security',
	'Hardware & devices': 'Hardware',
	'Startups, business & finance': 'Business',
	'Science & space': 'Science',
	'Society, politics & law': 'Society',
	'Web, apps & consumer tech': 'Web',
	Other: 'Other',
};
const MIN_POINTS = [20, 50, 100, 300] as const;
type MinPoints = (typeof MIN_POINTS)[number];

const N = (v: unknown): number => (v == null ? 0 : Number(v));
const S = (v: unknown): string => (v == null ? '' : String(v));
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : `${Math.round(n)}`);
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`);
const sqlList = (xs: string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ');

// ── Cache build plan: chunked so the connection stays responsive and progress is real ──
const DAILY_CHUNKS: [number, number][] = [[2006, 2009], [2010, 2012], [2013, 2015], [2016, 2018], [2019, 2021], [2022, 2026]];
const TOP_CHUNKS: [number, number][] = [[2006, 2016], [2017, 2026]];
const CACHE_STEPS: { label: string; sql: string }[] = [
	...DAILY_CHUNKS.map(([a, b], k) => ({
		label: `daily topics ${a}–${b}`,
		sql: `CREATE TEMP TABLE IF NOT EXISTS daily_topics_${k} AS SELECT * FROM ${CLOUD}."daily_topics" WHERE yr BETWEEN ${a} AND ${b}`,
	})),
	...TOP_CHUNKS.map(([a, b], k) => ({
		label: `top stories ${a}–${b}`,
		sql: `CREATE TEMP TABLE IF NOT EXISTS top_stories_${k} AS SELECT * FROM ${CLOUD}."top_stories" WHERE yr BETWEEN ${a} AND ${b}`,
	})),
	{
		label: 'stitch daily_topics view',
		sql: `CREATE TEMP VIEW IF NOT EXISTS daily_topics AS ${DAILY_CHUNKS.map((_, k) => `SELECT * FROM ${LOCAL}."daily_topics_${k}"`).join(' UNION ALL ')}`,
	},
	{
		label: 'stitch top_stories view',
		sql: `CREATE TEMP VIEW IF NOT EXISTS top_stories AS ${TOP_CHUNKS.map((_, k) => `SELECT * FROM ${LOCAL}."top_stories_${k}"`).join(' UNION ALL ')}`,
	},
];

const CACHE_DISPLAY_SQL = `-- ${CACHE_STEPS.length} statements, one per slice, so the connection stays free and the progress bar is real:
${CACHE_STEPS[0].sql}
-- … then two TEMP VIEWs stitch the slices back together as daily_topics and top_stories`;

// ── Hooks ─────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
type Timed = {
	label: string;
	sql: string;
	data: readonly Row[] | undefined;
	isLoading: boolean;
	isSuccess: boolean;
	isError: boolean;
	error: unknown;
	ms: number | null; // interaction → this panel's rows arrived (includes time queued behind other panels)
	startedAt: number;
	endedAt: number | null;
};

// Timing that matches what the viewer sees: the clock starts synchronously in the
// render where the SQL text changes, and stops in a layout effect (before paint) in
// the render where new rows are present. No dependence on isLoading flips.
function useTimed(label: string, sql: string, enabled = true): Timed {
	const q = useSQLQuery(sql, { enabled });
	const keyRef = useRef<string | null>(null);
	const startRef = useRef(performance.now());
	const endRef = useRef<number | null>(null);
	const seenRef = useRef<unknown>(undefined);
	const [, bump] = useState(0);
	if (keyRef.current !== sql) {
		keyRef.current = sql;
		startRef.current = performance.now();
		endRef.current = null;
	}
	const arrived = q.data !== undefined && q.data !== seenRef.current;
	useLayoutEffect(() => {
		if (!enabled || endRef.current != null) return;
		if (arrived || q.isError) {
			endRef.current = performance.now();
			seenRef.current = q.data;
			queryLog.record({
				label,
				sql,
				ms: endRef.current - startRef.current,
				rows: Array.isArray(q.data) ? q.data.length : 0,
				startedAt: startRef.current,
				error: q.isError ? String(q.error) : undefined,
			});
			bump((t) => t + 1);
		}
	});
	const data = Array.isArray(q.data) ? (q.data as readonly Row[]) : undefined;
	const pending = enabled && endRef.current == null && !q.isError;
	return {
		label,
		sql,
		data,
		isLoading: pending || q.isLoading,
		isSuccess: q.isSuccess,
		isError: q.isError,
		error: q.error,
		ms: endRef.current != null ? endRef.current - startRef.current : null,
		startedAt: startRef.current,
		endedAt: endRef.current,
	};
}

// Runs a fixed list of statements one after another; each step is enabled once the previous succeeded.
function useChain(steps: { sql: string }[], enabled: boolean) {
	let prevOk = enabled;
	let done = 0;
	let error: unknown = null;
	for (const step of steps) {
		// eslint-disable-next-line react-hooks/rules-of-hooks -- constant-length list, stable hook order
		const q = useSQLQuery(step.sql, { enabled: prevOk });
		if (prevOk && q.isSuccess) done++;
		if (prevOk && q.isError && error == null) error = q.error;
		prevOk = prevOk && q.isSuccess;
	}
	const ready = enabled && done === steps.length;
	const startRef = useRef<number | null>(null);
	const [elapsed, setElapsed] = useState<number | null>(null);
	useEffect(() => {
		if (enabled && !ready) {
			if (startRef.current == null) startRef.current = performance.now();
			const t = setInterval(() => setElapsed(performance.now() - (startRef.current ?? performance.now())), 100);
			return () => clearInterval(t);
		}
		if (ready && startRef.current != null) {
			const ms = performance.now() - startRef.current;
			setElapsed(ms);
			queryLog.record({ label: 'build local cache', sql: CACHE_DISPLAY_SQL, ms, rows: 0, startedAt: startRef.current, tag: 'cache' });
			startRef.current = null;
		}
	}, [enabled, ready]);
	return { done, total: steps.length, ready, error, elapsed };
}

function useDebounced<T>(value: T, ms: number): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		if (ms <= 0) { setV(value); return; }
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

// ── Component ─────────────────────────────────────────────────────────────
export default function HackerNewsLakehouse() {
	// Persistent state (travels with the Dive URL)
	const [side, setSide] = useDiveState<Engine>('engine', 'cloud');
	const [savedRange, setSavedRange] = useDiveState<[number, number]>('range_2026', DEFAULT_RANGE);
	const [topics, setTopics] = useDiveState<string[]>('topics', []);
	const [minPts, setMinPts] = useDiveState<MinPoints>('minPts', 20);
	const [gran, setGran] = useDiveState<'month' | 'quarter' | 'year'>('gran', 'month');
	const [mode, setMode] = useDiveState<'count' | 'share'>('mode', 'count');
	const [sortBy, setSortBy] = useDiveState<'score' | 'comments'>('sortBy', 'score');
	const [themePref, setThemePref] = useDiveState<ThemePref>('theme', 'auto');
	const systemDark = useSystemDark();
	const theme: Theme = themePref === 'light' || themePref === 'dark' ? themePref : systemDark ? 'dark' : 'light';
	M = theme === 'dark' ? DARK : LIGHT;

	const selected = Array.isArray(topics) ? topics.filter((t) => TOPICS.includes(t)) : [];
	const sfx = minPts === 20 ? '' : `_ge${minPts}`;

	// ── Engine: cloud, or DuckDB-Wasm once the chunked cache is built ─────
	const wantWasm = side === 'wasm';
	const cache = useChain(CACHE_STEPS, wantWasm);
	const engine: Engine = wantWasm && cache.ready ? 'wasm' : 'cloud';
	const T = engine === 'wasm' ? LOCAL : CLOUD;
	const cacheRows = useTimed('count cached rows', `SELECT (SELECT count(*) FROM ${LOCAL}."daily_topics") + (SELECT count(*) FROM ${LOCAL}."top_stories") AS n`, engine === 'wasm');

	// ── Range slider: live while dragging; SQL follows immediately in wasm mode, debounced in cloud mode ──
	const [liveRange, setLiveRange] = useState<[number, number]>(Array.isArray(savedRange) && savedRange.length === 2 ? savedRange : DEFAULT_RANGE);
	useEffect(() => {
		if (Array.isArray(savedRange) && savedRange.length === 2 && (savedRange[0] !== liveRange[0] || savedRange[1] !== liveRange[1])) setLiveRange(savedRange);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [savedRange]);
	const sqlRange = useDebounced(liveRange, engine === 'wasm' ? 40 : 350);
	useEffect(() => {
		const t = setTimeout(() => {
			if (!Array.isArray(savedRange) || savedRange[0] !== liveRange[0] || savedRange[1] !== liveRange[1]) setSavedRange(liveRange);
		}, 600);
		return () => clearTimeout(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveRange]);
	const [i0, i1] = sqlRange;
	const m0 = MONTHS[Math.min(i0, i1)];
	const m1 = MONTHS[Math.max(i0, i1)];
	const dateFilter = `d >= DATE '${m0}-01' AND d < DATE '${m1}-01' + INTERVAL 1 MONTH`;
	const topicFilter = selected.length ? `AND topic IN (${sqlList(selected)})` : '';

	// ── The four analytical queries (identical SQL on either engine) ───────
	const kpis = useTimed(
		'kpi totals',
		`SELECT sum(stories${sfx}) AS stories, sum(score${sfx}) AS score, sum(comments${sfx}) AS comments,
		        sum(stories${sfx}) FILTER (WHERE topic = 'AI & machine learning') AS ai_stories
		 FROM ${T}."daily_topics" WHERE ${dateFilter} ${topicFilter}`,
	);
	const periodExpr = gran === 'year' ? `yr::VARCHAR` : gran === 'quarter' ? `yr::VARCHAR || '-Q' || quarter(d)::VARCHAR` : `strftime(month, '%Y-%m')`;
	const trend = useTimed(
		`trend by ${gran}`,
		`SELECT ${periodExpr} AS period, topic, sum(stories${sfx}) AS stories
		 FROM ${T}."daily_topics" WHERE ${dateFilter} ${topicFilter}
		 GROUP BY ALL ORDER BY period`,
	);
	const byTopic = useTimed(
		'stories by topic',
		`SELECT topic, sum(stories${sfx}) AS stories
		 FROM ${T}."daily_topics" WHERE ${dateFilter}
		 GROUP BY 1 ORDER BY 2 DESC`,
	);
	const top = useTimed(
		'top stories',
		`SELECT title, url, domain, strftime(d, '%Y-%m-%d') AS day, score, comments, topic
		 FROM ${T}."top_stories" WHERE ${dateFilter} AND score >= ${minPts} ${topicFilter}
		 ORDER BY ${sortBy === 'comments' ? 'comments' : 'score'} DESC, score DESC LIMIT 10`,
	);
	// Sparkline behind the slider: whole history, unfiltered, one row per month.
	const spark = useTimed('sparkline', `SELECT strftime(month, '%Y-%m') AS m, sum(stories) AS n FROM ${T}."daily_topics" GROUP BY 1 ORDER BY 1`);

	// ── Shape data ─────────────────────────────────────────────────────────
	const kpi = kpis.data?.[0];
	const visibleTopics = selected.length ? TOPICS.filter((t) => selected.includes(t)) : TOPICS;
	const trendData = useMemo(() => {
		const rows = trend.data ?? [];
		const byPeriod = new Map<string, Record<string, number | string>>();
		for (const r of rows) {
			const p = S(r.period);
			if (!byPeriod.has(p)) byPeriod.set(p, { period: p });
			byPeriod.get(p)![S(r.topic)] = N(r.stories);
		}
		const out = Array.from(byPeriod.values());
		if (mode === 'share') {
			for (const row of out) {
				const total = visibleTopics.reduce((a, t) => a + N(row[t]), 0) || 1;
				for (const t of visibleTopics) row[t] = Math.round((N(row[t]) / total) * 1000) / 10;
			}
		}
		return out;
	}, [trend.data, mode, visibleTopics.join('|')]);
	const topicData = (byTopic.data ?? []).map((r) => ({ topic: S(r.topic), short: SHORT[S(r.topic)] ?? S(r.topic), stories: N(r.stories) }));
	const topRows = top.data ?? [];
	const sparkData = useMemo(() => {
		const m = new Map((spark.data ?? []).map((r) => [S(r.m), N(r.n)]));
		return MONTHS.map((ym) => m.get(ym) ?? 0);
	}, [spark.data]);

	// Wall-clock for the latest interaction: only the panels whose SQL changed in it
	// (same render, so same start) count; it ends when the last of them has its rows.
	const panels = [kpis, trend, byTopic, top];
	const interactionStart = Math.max(...panels.map((p) => p.startedAt));
	const touched = panels.filter((p) => p.startedAt >= interactionStart - 20);
	const anyLoading = touched.some((p) => p.endedAt == null);
	const totalMs = anyLoading ? 0 : Math.max(...touched.map((p) => p.endedAt as number)) - interactionStart;
	const touchedCount = touched.length;

	const toggleTopic = (t: string) => setTopics(selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t]);
	// Docking pane: pinned = docked beside the dashboard (content makes room); open but unpinned = overlay.
	const [docked, setDocked] = useState(false);

	// ── Render ─────────────────────────────────────────────────────────────
	return (
		<div style={{ background: M.bg, color: M.ink, fontFamily: SANS, minHeight: 600, fontSize: 14, lineHeight: 1.5, colorScheme: theme }}>
			<style>{FONT_CSS}</style>

			{/* Announcement bar, as on muredata.com */}
			<div style={{ background: M.bar, color: M.barInk, borderBottom: theme === 'dark' ? `1px solid ${M.border}` : 'none', fontFamily: MONO, fontSize: 12, padding: `9px ${docked ? RAIL_W + 28 : 28}px 9px 28px`, transition: 'padding-right .35s cubic-bezier(.2,.8,.2,1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
				<span>
					<span style={{ fontWeight: 600 }}>Mure Forward 26:</span> DuckDB + Apache Iceberg · November 19
				</span>
				<span className="inline-flex items-center gap-4">
					<span style={{ opacity: 0.75, display: docked ? 'none' : undefined }}>One Prompt, One Lakehouse · MotherDuck</span>
					<ThemeSwitch value={themePref} onChange={setThemePref} />
				</span>
			</div>

			<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', paddingRight: docked ? RAIL_W : 0, transition: 'padding-right .35s cubic-bezier(.2,.8,.2,1)' }}>
			<div style={{ flex: '1 1 620px', minWidth: 0, padding: '24px 44px 20px 28px' }}>
				{/* Header */}
				<div className="mb-5" style={{ paddingBottom: 18, borderBottom: `1px solid ${M.border}` }}>
					<div style={{ ...eyebrow, marginBottom: 10 }}>Hacker News · Apache Iceberg on S3 Tables · us-east-1</div>
					<h1 style={{ fontSize: 28, fontWeight: 500, lineHeight: 1.06, letterSpacing: '-0.035em', margin: 0 }}>
						<span style={{ display: 'block' }}>What Hacker News talked about,</span>
						<span style={{ display: 'block', color: M.green }}>
							{monthLabel(m0)} – {monthLabel(m1)}.
						</span>
					</h1>
					<p style={{ color: M.sub, fontSize: 14, marginTop: 12, maxWidth: 560 }}>
						Stories with {minPts}+ points, topic-classified with <code style={{ fontFamily: MONO, fontSize: 12.5 }}>prompt_jev()</code>. Every panel is SQL on Apache Iceberg in S3 Tables.
					</p>
				</div>

				{/* Timeline slider */}
				<RangeSlider value={liveRange} onChange={setLiveRange} spark={sparkData} engine={engine} />

				{/* Filters */}
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-3">
					<Seg value={gran} onChange={setGran} options={[['month', 'Monthly'], ['quarter', 'Quarterly'], ['year', 'Yearly']]} />
					<Seg value={mode} onChange={setMode} options={[['count', 'Stories'], ['share', 'Share %']]} />
					<span className="flex items-center gap-2" style={eyebrow}>
						Min points
						<Seg value={minPts} onChange={(v) => setMinPts(v)} options={MIN_POINTS.map((p) => [p, `${p}+`] as [MinPoints, string])} />
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-1.5 mb-6">
					{TOPICS.map((t) => {
						const on = selected.length === 0 || selected.includes(t);
						const isSel = selected.includes(t);
						return (
							<button
								key={t}
								type="button"
								onClick={() => toggleTopic(t)}
								className="inline-flex items-center gap-1.5"
								style={{
									fontFamily: SANS,
									fontSize: 12,
									fontWeight: 500,
									padding: '4px 11px',
									borderRadius: 999,
									background: isSel ? TOPIC_COLOR[t] : M.card,
									color: isSel ? (LIGHT_TOPIC.has(t) ? LIGHT.ink : '#fff') : on ? M.ink : M.quiet,
									boxShadow: `0 0 0 1px ${isSel ? TOPIC_COLOR[t] : M.border}`,
									border: 'none',
									cursor: 'pointer',
									transition: 'background 120ms, color 120ms',
								}}
							>
								<span style={{ width: 8, height: 8, borderRadius: 999, background: isSel ? (LIGHT_TOPIC.has(t) ? LIGHT.ink : '#fff') : TOPIC_COLOR[t], opacity: on ? 1 : 0.35 }} />
								{SHORT[t]}
							</button>
						);
					})}
					{selected.length > 0 && (
						<button type="button" onClick={() => setTopics([])} style={{ ...eyebrow, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', textDecoration: 'underline', textUnderlineOffset: 3 }}>
							clear
						</button>
					)}
				</div>

				{/* KPIs: one bordered panel, cells divided by hairlines (the brand-page grid) */}
				<div className="grid grid-cols-4 mb-6" style={{ border: `1px solid ${M.border}`, borderRadius: 8, background: M.card, overflow: 'hidden' }}>
					<Kpi label={`Stories ${minPts}+`} value={fmt(N(kpi?.stories))} q={kpis} engine={engine} />
					<Kpi label="Points" value={fmt(N(kpi?.score))} q={kpis} engine={engine} />
					<Kpi label="Comments" value={fmt(N(kpi?.comments))} q={kpis} engine={engine} />
					<Kpi label="About AI" value={`${kpi ? ((N(kpi.ai_stories) / Math.max(1, N(kpi.stories))) * 100).toFixed(1) : '0'}%`} q={kpis} engine={engine} last />
				</div>

				{/* Trend */}
				<Section title={`Stories per ${gran} by topic${mode === 'share' ? ' (share)' : ''}`} q={trend} engine={engine}>
					<ResponsiveContainer width="100%" height={240}>
						<AreaChart data={trendData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
							<CartesianGrid strokeDasharray="3 3" stroke={M.panel} vertical={false} />
							<XAxis dataKey="period" fontSize={11} minTickGap={32} tick={{ fill: M.muted }} tickLine={false} axisLine={{ stroke: M.border }} />
							<YAxis fontSize={11} tick={{ fill: M.muted }} tickLine={false} axisLine={false} tickFormatter={(v) => (mode === 'share' ? `${v}%` : fmt(v))} domain={mode === 'share' ? [0, 100] : undefined} />
							<Tooltip
								formatter={(v, name) => [mode === 'share' ? `${N(v)}%` : N(v).toLocaleString(), String(name)]}
								contentStyle={TOOLTIP}
								itemStyle={{ color: M.ink }}
								labelStyle={{ color: M.muted, fontFamily: MONO, fontSize: 11 }}
								itemSorter={(item) => -(item.value as number)}
							/>
							{visibleTopics.slice().reverse().map((t) => (
								<Area key={t} type="linear" dataKey={t} stackId="1" stroke={M.card} fill={TOPIC_COLOR[t]} fillOpacity={0.9} strokeWidth={1} isAnimationActive={false} />
							))}
						</AreaChart>
					</ResponsiveContainer>
				</Section>

				<div className="grid grid-cols-2 gap-5 mt-5">
					{/* Topic bars */}
					<Section title="Stories by topic" hint="click a bar to select" q={byTopic} engine={engine}>
						<ResponsiveContainer width="100%" height="100%" minHeight={280}>
							<BarChart data={topicData} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }} barCategoryGap={6}>
								<CartesianGrid strokeDasharray="3 3" stroke={M.panel} horizontal={false} />
								<XAxis type="number" fontSize={11} tick={{ fill: M.muted }} tickLine={false} axisLine={{ stroke: M.border }} tickFormatter={fmt} />
								<YAxis type="category" dataKey="short" fontSize={11} width={64} tick={{ fill: M.sub }} tickLine={false} axisLine={false} />
								<Tooltip
									formatter={(v) => N(v).toLocaleString()}
									labelFormatter={(_l, p) => (p && p[0] ? String(p[0].payload.topic) : '')}
									contentStyle={TOOLTIP}
									itemStyle={{ color: M.ink }}
									labelStyle={{ color: M.muted, fontFamily: MONO, fontSize: 11 }}
									cursor={{ fill: M.panel }}
								/>
								<Bar
									dataKey="stories"
									isAnimationActive={false}
									onClick={(d) => {
										const t = (d as unknown as { payload?: { topic?: string } })?.payload?.topic ?? (d as unknown as { topic?: string })?.topic;
										if (t) toggleTopic(t);
									}}
									cursor="pointer"
									shape={(p: { x?: number; y?: number; width?: number; height?: number; payload?: { topic: string } }) => (
										<rect x={p.x} y={p.y} width={p.width} height={p.height} rx={3} fill={TOPIC_COLOR[p.payload?.topic ?? ''] ?? M.green} opacity={selected.length && !selected.includes(p.payload?.topic ?? '') ? 0.25 : 1} />
									)}
								/>
							</BarChart>
						</ResponsiveContainer>
					</Section>

					{/* Top stories */}
					<Section
						title={`Top stories${selected.length === 1 ? ` · ${SHORT[selected[0]]}` : ''}`}
						q={top}
						engine={engine}
						right={<Seg value={sortBy} onChange={setSortBy} options={[['score', 'by points'], ['comments', 'by comments']]} small />}
					>
						<table className="w-full" style={{ color: M.ink, fontSize: 12.5 }}>
							<tbody>
								{topRows.map((r, i) => (
									<tr key={i} style={{ borderTop: i ? `1px solid ${M.panel}` : 'none' }}>
										<td className="py-1.5 pr-2 align-top" style={{ maxWidth: 0, width: '72%' }}>
											<a href={S(r.url) || 'https://news.ycombinator.com'} target="_blank" rel="noopener noreferrer" className="hover:underline block truncate" title={S(r.title)} style={{ fontWeight: 500, textUnderlineOffset: 3 }}>
												{S(r.title)}
											</a>
											<div style={{ color: M.muted, fontSize: 11.5, marginTop: 1 }}>
												<span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: TOPIC_COLOR[S(r.topic)], marginRight: 5, verticalAlign: 'middle' }} />
												{SHORT[S(r.topic)]} · {S(r.domain) || 'news.ycombinator.com'} · <span style={{ fontFamily: MONO, fontSize: 11 }}>{S(r.day)}</span>
											</div>
										</td>
										<td className="py-1.5 text-right align-top tabular-nums whitespace-nowrap" style={{ fontFamily: MONO, fontSize: 12, color: sortBy === 'score' ? M.ink : M.muted, fontWeight: sortBy === 'score' ? 500 : 400 }}>
											{N(r.score).toLocaleString()} pts
										</td>
										<td className="py-1.5 pl-3 text-right align-top tabular-nums whitespace-nowrap" style={{ fontFamily: MONO, fontSize: 12, color: sortBy === 'comments' ? M.ink : M.muted, fontWeight: sortBy === 'comments' ? 500 : 400 }}>
											{N(r.comments).toLocaleString()} c
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</Section>
				</div>

				{/* Footer, in the site's mono-caps register */}
				<div className="flex items-center justify-between gap-4 flex-wrap" style={{ ...eyebrow, color: M.quiet, fontSize: 10.5, letterSpacing: '0.08em', marginTop: 28, paddingTop: 14, borderTop: `1px solid ${M.border}` }}>
					<span>Source: Hacker News 2006 → 15 Nov 2026 (OpenPipe dump + MotherDuck hacker_news share) · 50.5M items in Iceberg · MotherDuck Flight · prompt_jev()</span>
					<span>Mure Forward 26 · MotherDuck</span>
				</div>
			</div>

			{/* What just ran: the dark rail */}
			<Rail
				phase={!wantWasm ? 'cloud' : cache.ready ? 'local' : cache.error ? 'cloud' : 'building'}
				running={anyLoading}
				interactionStart={interactionStart}
				totalMs={totalMs}
				touchedCount={touchedCount}
				pending={touched.filter((p) => p.endedAt == null).map((p) => ({ label: p.label, sql: p.sql }))}
				cache={cache}
				cacheRowCount={engine === 'wasm' ? N(cacheRows.data?.[0]?.n) : null}
				side={side}
				setSide={setSide}
				theme={theme}
				docked={docked}
				setDocked={setDocked}
			/>
			</div>
		</div>
	);
}

const TOOLTIP = { fontSize: 12, fontFamily: SANS, get background() { return M.card; }, get border() { return `1px solid ${M.border}`; }, borderRadius: 8, get boxShadow() { return `0 4px 18px ${M.shadow}`; }, padding: '8px 10px' };

// ── Range slider with sparkline ───────────────────────────────────────────
function RangeSlider({ value, onChange, spark, engine }: { value: [number, number]; onChange: (v: [number, number]) => void; spark: number[]; engine: Engine }) {
	const [a, b] = value;
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	const max = MONTHS.length - 1;
	const peak = Math.max(1, ...spark);
	// Grab the selected window and slide it, keeping its width. The handles still resize.
	const trackRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ x: number; lo: number; hi: number } | null>(null);
	const [dragging, setDragging] = useState(false);
	const onWindowDown = (e: React.PointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
		dragRef.current = { x: e.clientX, lo, hi };
		setDragging(true);
	};
	const onWindowMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		const track = trackRef.current;
		if (!d || !track) return;
		const pxPerMonth = (track.clientWidth - 14) / max;
		const dm = Math.round((e.clientX - d.x) / pxPerMonth);
		const width = d.hi - d.lo;
		const nlo = Math.max(0, Math.min(max - width, d.lo + dm));
		if (nlo !== lo) onChange([nlo, nlo + width]);
	};
	const onWindowUp = () => {
		dragRef.current = null;
		setDragging(false);
	};
	const thumb = (left: boolean) => ({
		position: 'absolute' as const,
		left: 0,
		right: 0,
		top: 0,
		width: '100%',
		height: 44,
		margin: 0,
		background: 'transparent',
		appearance: 'none' as const,
		WebkitAppearance: 'none' as const,
		pointerEvents: 'none' as const,
		zIndex: left ? 3 : 4,
	});
	const accent = ENGINE_COLOR[engine];
	const fill = ENGINE_FILL[engine];
	return (
		<div className="mb-4 select-none">
			<style>{`
				.hn-range::-webkit-slider-thumb { -webkit-appearance: none; pointer-events: all; width: 14px; height: 28px; border-radius: 4px; background: ${M.card}; border: 1.5px solid ${accent}; box-shadow: 0 1px 3px rgba(10,10,10,.25); cursor: ew-resize; }
				.hn-range::-moz-range-thumb { pointer-events: all; width: 14px; height: 28px; border-radius: 4px; background: ${M.card}; border: 1.5px solid ${accent}; cursor: ew-resize; }
				.hn-range:focus { outline: none; }
				.hn-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px ${fill}66; }
				.hn-range::-webkit-slider-runnable-track { background: transparent; }
				.hn-range::-moz-range-track { background: transparent; }
			`}</style>
			<div className="flex items-baseline justify-between mb-1" style={{ fontSize: 12, color: M.muted }}>
				<span>Drag the handles to resize, grab the window to move it · {hi - lo + 1} months selected</span>
				<span className="tabular-nums" style={{ color: M.ink, fontFamily: MONO, fontSize: 12 }}>{monthLabel(MONTHS[lo])} → {monthLabel(MONTHS[hi])}</span>
			</div>
			<div ref={trackRef} style={{ position: 'relative', height: 44 }}>
				{/* sparkline bars */}
				<div style={{ position: 'absolute', inset: '4px 7px 10px 7px', display: 'flex', alignItems: 'flex-end', gap: 0 }}>
					{spark.map((v, i) => {
						const inWin = i >= lo && i <= hi;
						return <div key={i} style={{ flex: 1, height: `${Math.max(2, (v / peak) * 100)}%`, background: inWin ? fill : M.stone, opacity: inWin ? (engine === 'wasm' ? 0.9 : 0.6) : 0.5 }} />;
					})}
				</div>
				{/* selected window: draggable as a whole */}
				<div
					onPointerDown={onWindowDown}
					onPointerMove={onWindowMove}
					onPointerUp={onWindowUp}
					onPointerCancel={onWindowUp}
					title="Drag to move the window"
					style={{
						position: 'absolute',
						top: 2,
						bottom: 8,
						left: `calc(7px + (100% - 14px) * ${lo / max})`,
						width: `calc((100% - 14px) * ${(hi - lo) / max})`,
						border: `1px solid ${accent}`,
						borderRadius: 4,
						background: dragging ? `${fill}33` : 'transparent',
						cursor: dragging ? 'grabbing' : 'grab',
						zIndex: 2,
						touchAction: 'none',
					}}
				/>
				<input className="hn-range" type="range" min={0} max={max} value={a} onChange={(e) => onChange([Number(e.target.value), b])} style={thumb(true)} aria-label="From month" />
				<input className="hn-range" type="range" min={0} max={max} value={b} onChange={(e) => onChange([a, Number(e.target.value)])} style={thumb(false)} aria-label="To month" />
			</div>
			<div style={{ ...eyebrow, color: M.quiet, fontSize: 10.5, position: 'relative', height: 14 }}>
				{[2007, 2009, 2011, 2013, 2015, 2017, 2019, 2021, 2023, 2025].map((y) => (
					<span key={y} style={{ position: 'absolute', left: `calc(7px + (100% - 14px) * ${MONTHS.indexOf(`${y}-01`) / max})`, transform: 'translateX(-50%)' }}>{y}</span>
				))}
			</div>
		</div>
	);
}

// ── Small components ──────────────────────────────────────────────────────
function Latency({ ms, loading, engine }: { ms: number | null; loading: boolean; engine: Engine }) {
	return (
		<span className="tabular-nums" title="Time from the interaction until this panel's rows arrived (includes time queued behind other panels)" style={{ fontSize: 11.5, color: loading ? M.quiet : ENGINE_COLOR[engine], fontFamily: MONO }}>
			{loading ? '…' : ms != null ? fmtMs(ms) : ''}
		</span>
	);
}

function EngineToggle({ side, setSide, error }: { side: Engine; setSide: (e: Engine) => void; error: unknown }) {
	const opts: [Engine, string, string, typeof Cloud, string][] = [
		['cloud', 'MotherDuck', 'cloud · on iceberg', Cloud, 'Every query runs in MotherDuck against the Iceberg tables'],
		['wasm', 'DuckDB-Wasm', 'in your browser', Zap, 'Serving tables copied once into DuckDB-Wasm temp tables; the same SQL then runs in the browser'],
	];
	return (
		<div style={{ marginBottom: 12 }}>
			<div className="flex items-baseline justify-between gap-3" style={{ marginBottom: 6 }}>
				<span style={{ ...eyebrow, color: D.muted, fontSize: 10 }}>engine</span>
				<span style={{ ...eyebrow, color: D.quiet, fontSize: 10 }}>same component · same sql</span>
			</div>
			<div role="radiogroup" aria-label="Query engine" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, background: D.card, border: `1px solid ${D.border}`, borderRadius: 10 }}>
				{opts.map(([value, label, sub, Icon, title]) => {
					const active = side === value;
					const accent = value === 'wasm' ? D.green : D.cloud;
					return (
						<button
							key={value}
							type="button"
							role="radio"
							aria-checked={active}
							title={title}
							onClick={() => setSide(value)}
							style={{ textAlign: 'left', minWidth: 0, padding: '7px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', background: active ? accent : 'transparent', color: active ? LIGHT.ink : D.sub, transition: 'background 120ms, color 120ms' }}
						>
							<span className="inline-flex items-center gap-1.5" style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
								<Icon size={13} /> {label}
							</span>
							<span style={{ display: 'block', fontFamily: MONO, fontSize: 10, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: active ? LIGHT.forest : D.muted }}>{sub}</span>
						</button>
					);
				})}
			</div>
			{error != null && <div role="alert" style={{ marginTop: 6, fontSize: 11, color: D.danger }}>Building the DuckDB-Wasm cache failed: {String(error)}</div>}
		</div>
	);
}

// Auto / light / dark, in the announcement bar. Auto follows the viewer's system (or the app's) colour scheme.
function ThemeSwitch({ value, onChange }: { value: ThemePref; onChange: (v: ThemePref) => void }) {
	const opts: ThemePref[] = ['auto', 'light', 'dark'];
	return (
		<span role="radiogroup" aria-label="Colour theme" className="inline-flex" style={{ border: `1px solid ${M.barInk}40`, borderRadius: 999, padding: 2, gap: 2 }}>
			{opts.map((v) => {
				const on = value === v;
				return (
					<button
						key={v}
						type="button"
						role="radio"
						aria-checked={on}
						onClick={() => onChange(v)}
						style={{ fontFamily: MONO, fontSize: 11, lineHeight: '16px', padding: '1px 9px', borderRadius: 999, border: 'none', cursor: 'pointer', background: on ? M.barInk : 'transparent', color: on ? M.bar : M.barInk, opacity: on ? 1 : 0.7 }}
					>
						{v}
					</button>
				);
			})}
		</span>
	);
}

function Seg<T extends string | number>({ value, onChange, options, small }: { value: T; onChange: (v: T) => void; options: [T, string][]; small?: boolean }) {
	return (
		<div className="flex" style={{ boxShadow: `0 0 0 1px ${M.border}`, borderRadius: 8, background: M.card, overflow: 'hidden' }}>
			{options.map(([v, label], i) => (
				<button
					key={String(v)}
					type="button"
					onClick={() => onChange(v)}
					style={{
						fontFamily: SANS,
						fontSize: small ? 11.5 : 12.5,
						fontWeight: 500,
						padding: small ? '3px 9px' : '5px 12px',
						background: value === v ? M.ink : 'transparent',
						color: value === v ? M.bg : M.sub,
						border: 'none',
						borderLeft: i ? `1px solid ${M.border}` : 'none',
						cursor: 'pointer',
					}}
				>
					{label}
				</button>
			))}
		</div>
	);
}

function Kpi({ label, value, q, engine, last }: { label: string; value: string; q: Timed; engine: Engine; last?: boolean }) {
	return (
		<div style={{ padding: '16px 18px 14px', borderRight: last ? 'none' : `1px solid ${M.border}` }}>
			<div className="flex items-center justify-between gap-2" style={{ ...eyebrow, marginBottom: 8, whiteSpace: 'nowrap' }}>
				<span>{label}</span>
				<Latency ms={q.ms} loading={q.isLoading} engine={engine} />
			</div>
			{q.isLoading && q.data === undefined ? (
				<div className="animate-pulse" style={{ height: 44, width: 96, background: M.panel, borderRadius: 6 }} />
			) : q.isError ? (
				<p className="text-sm" role="alert" style={{ color: M.danger }}>{String(q.error)}</p>
			) : (
				<p className="tabular-nums" style={{ fontSize: 40, fontWeight: 500, letterSpacing: '-0.035em', lineHeight: 1.1, margin: 0, opacity: q.isLoading ? 0.5 : 1, transition: 'opacity 150ms' }}>
					{value}
				</p>
			)}
		</div>
	);
}

function Section({ title, hint, q, engine, right, children }: { title: string; hint?: string; q: Timed; engine: Engine; right?: React.ReactNode; children: React.ReactNode }) {
	return (
		<div style={{ background: M.card, border: `1px solid ${M.border}`, borderRadius: 8, padding: '14px 16px 12px', display: 'flex', flexDirection: 'column' }}>
			<div className="flex items-center justify-between mb-3 gap-2">
				<h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, letterSpacing: '-0.01em' }}>
					{title}
					{hint && <span style={{ ...eyebrow, marginLeft: 10 }}>{hint}</span>}
				</h2>
				<div className="flex items-center gap-3">
					{right}
					<Latency ms={q.ms} loading={q.isLoading} engine={engine} />
				</div>
			</div>
			{q.isLoading && q.data === undefined ? (
				<div className="animate-pulse" style={{ height: 240, background: M.panel, borderRadius: 6 }} />
			) : q.isError ? (
				<p className="text-sm" role="alert" style={{ color: M.danger }}>{String(q.error)}</p>
			) : (
				<div style={{ opacity: q.isLoading ? 0.5 : 1, transition: 'opacity 150ms', flex: 1, minHeight: 0 }}>{children}</div>
			)}
		</div>
	);
}

// ── The rail: where each query ran, how long it took, and the SQL behind it ──
type Phase = 'cloud' | 'building' | 'local';
const CACHE_ROW_ID = -1;
const TRACE_MAX = 9;

function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
	const ref = useRef<T>(null);
	const [w, setW] = useState(fallback);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
		ro.observe(el);
		setW(Math.round(el.getBoundingClientRect().width));
		return () => ro.disconnect();
	}, []);
	return [ref, w];
}

// Live stopwatch: ticks while the interaction's panels are still waiting for rows.
function useStopwatch(running: boolean, startedAt: number, settledMs: number) {
	const [, tick] = useState(0);
	useEffect(() => {
		if (!running) return;
		const t = setInterval(() => tick((x) => x + 1), 33);
		return () => clearInterval(t);
	}, [running]);
	return running ? performance.now() - startedAt : settledMs;
}

function Rail({ phase, running, interactionStart, totalMs, touchedCount, pending, cache, cacheRowCount, side, setSide, theme, docked, setDocked }: {
	phase: Phase;
	running: boolean;
	interactionStart: number;
	totalMs: number;
	touchedCount: number;
	pending: { label: string; sql: string }[];
	cache: { done: number; total: number; ready: boolean; error: unknown; elapsed: number | null };
	cacheRowCount: number | null;
	side: Engine;
	setSide: (e: Engine) => void;
	theme: Theme;
	docked: boolean;
	setDocked: (fn: (v: boolean) => boolean) => void;
}) {
	const { log } = useQueryLog();
	const [ref, width] = useWidth<HTMLDivElement>(340);
	const [pinned, setPinned] = useState<number | null>(null);
	const stopwatch = useStopwatch(running, interactionStart, totalMs);
	// Docking pane: hidden off the right edge until the tab is clicked. Click outside or Esc closes it;
	// pinned (button or P key) it docks beside the dashboard and stays while you click around.
	const asideRef = useRef<HTMLElement | null>(null);
	const tabRef = useRef<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const paneOpen = open || docked;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
			if (e.key === 'p' || e.key === 'P') setDocked((v) => !v);
			if (e.key === 'Escape') { setOpen(false); setDocked(() => false); }
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [setDocked]);
	useEffect(() => {
		if (!open || docked) return;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node | null;
			if (t && (asideRef.current?.contains(t) || tabRef.current?.contains(t))) return;
			setOpen(false);
		};
		window.addEventListener('pointerdown', onDown);
		return () => window.removeEventListener('pointerdown', onDown);
	}, [open, docked]);
	useEffect(() => { if (!docked) setOpen(false); }, [docked]);

	// Rows of the current interaction: the ones whose clock started with it.
	const burstRows = log.filter((q) => !q.tag && q.startedAt >= interactionStart - BURST_GAP_MS);
	const rows = burstRows.slice(-TRACE_MAX);
	const hidden = burstRows.length - rows.length;
	const maxMs = Math.max(1, ...rows.map((q) => q.ms));
	const burstMs = burstRows.reduce((a, q) => a + q.ms, 0);
	const cacheRecord = log.filter((q) => q.tag === 'cache').pop() ?? null;
	const canPinCache = phase !== 'cloud';
	const shown = (pinned === CACHE_ROW_ID && canPinCache) || rows.some((q) => q.id === pinned) ? pinned : rows.length ? rows[rows.length - 1].id : canPinCache ? CACHE_ROW_ID : null;
	const shownRow = shown === CACHE_ROW_ID ? null : rows.find((q) => q.id === shown) ?? null;
	const shownSql = shown === CACHE_ROW_ID ? CACHE_DISPLAY_SQL : shownRow ? tidySql(shownRow.sql) : null;
	const shownLabel = shown === CACHE_ROW_ID ? 'build local cache' : shownRow?.label ?? '';
	const engineLine = phase === 'local'
		? `local ⚡ · ${cacheRowCount != null ? fmt(cacheRowCount) : '…'} rows in browser duckdb`
		: phase === 'building'
			? `building the cache · step ${Math.min(cache.done + 1, cache.total)} of ${cache.total}`
			: 'cloud · direct queries on iceberg';

	return (
		<>
		{/* tab on the right edge: a click slides the pane in */}
		<button
			ref={tabRef}
			onClick={() => setOpen(true)}
			title="Show what just ran (P pins it)"
			style={{ position: 'fixed', top: '50%', right: 0, transform: `translateY(-50%) translateX(${paneOpen ? '100%' : '0'})`, transition: 'transform .25s', zIndex: 40, width: 30, padding: '14px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, background: D.bg, color: D.lime, border: `1px solid ${D.border}`, borderRight: 'none', borderRadius: '10px 0 0 10px', cursor: 'pointer', boxShadow: '-6px 0 18px rgba(0,0,0,.25)' }}
		>
			<PanelRightOpen size={15} />
			<span style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: D.sub }}>what just ran</span>
		</button>
		<aside
			ref={asideRef}
			className="hn-rail"
			style={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: RAIL_W, maxWidth: '100%', zIndex: 50, background: D.bg, color: D.ink, fontFamily: SANS, fontSize: 12.5, borderLeft: `1px solid ${D.border}`, transform: paneOpen ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .35s cubic-bezier(.2,.8,.2,1), box-shadow .35s', boxShadow: paneOpen && !docked ? '-24px 0 48px rgba(0,0,0,.35)' : 'none' }}
		>
			<div ref={ref} style={{ height: '100%', overflowY: 'auto', padding: '18px 22px 20px' }}>
			<div className="flex items-center justify-between gap-2" style={{ marginBottom: 14 }}>
				<button
					onClick={() => setDocked((v) => !v)}
					title={docked ? 'Unpin (P): the pane closes on the next click outside' : 'Pin open (P): docks beside the dashboard'}
					style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 12, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: docked ? D.bg : D.lime, background: docked ? D.lime : 'transparent', border: `1.5px solid ${D.lime}`, borderRadius: 8, padding: '7px 14px', cursor: 'pointer' }}
				>
					<Pin size={15} fill={docked ? 'currentColor' : 'none'} />
					{docked ? 'pinned' : 'pin open'}
					<span style={{ fontWeight: 400, opacity: 0.7, marginLeft: 2 }}>P</span>
				</button>
				<button
					onClick={() => { setOpen(false); setDocked(() => false); }}
					title="Close (Esc)"
					style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, color: D.sub, background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 8, cursor: 'pointer' }}
				>
					<X size={16} />
				</button>
			</div>
			<style>{`
				.hn-rail .trace-row:hover{background:${D.rail}}
				.hn-rail .flow-dash{animation:hn-dash .6s linear infinite}
				@keyframes hn-dash{to{stroke-dashoffset:-18}}
				.hn-rail ::-webkit-scrollbar{width:6px}
				.hn-rail ::-webkit-scrollbar-thumb{background:${D.border};border-radius:3px}
			`}</style>

			<EngineToggle side={side} setSide={setSide} error={cache.error} />
			<DucklingCard />

			{/* header */}
			<div className="flex items-baseline justify-between gap-3" style={{ marginBottom: 8 }}>
				<span style={{ ...eyebrow, color: D.muted }}>what just ran</span>
				<span className="tabular-nums whitespace-nowrap" style={{ fontFamily: MONO, fontSize: 11, color: D.muted }}>
					{burstRows.length ? `${burstRows.length} ${burstRows.length === 1 ? 'query' : 'queries'} · ${Math.round(burstMs)} ms summed` : 'waiting for an interaction'}
				</span>
			</div>
			<div className="inline-flex items-center gap-2 tabular-nums whitespace-nowrap" style={{ fontFamily: MONO, fontSize: 15, fontWeight: 500, color: running ? D.lime : D.ink, letterSpacing: '-0.01em' }}>
				{running && <span className="animate-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: D.lime, display: 'inline-block' }} />}
				interaction {fmtMs(stopwatch)} · {touchedCount} {touchedCount === 1 ? 'query' : 'queries'}
			</div>
			<div style={{ fontFamily: MONO, fontSize: 11, marginTop: 2, marginBottom: 12, color: phase === 'cloud' ? D.cloud : phase === 'building' ? D.lime : D.green }}>{engineLine}</div>

			<FlowDiagram width={Math.max(260, width - 44)} phase={phase} running={running} chunksDone={cache.done} chunks={cache.total} cacheRows={cacheRowCount} cacheMs={cache.elapsed} />

			{/* the one-time cache build, pinnable like any other row */}
			{canPinCache && (
				<div
					className="trace-row"
					onClick={() => setPinned(CACHE_ROW_ID)}
					style={{ marginTop: 12, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', background: shown === CACHE_ROW_ID ? D.limeWash : D.card, border: `1px solid ${shown === CACHE_ROW_ID ? D.lime : D.border}55` }}
				>
					<div style={{ display: 'grid', gridTemplateColumns: '1fr auto 64px', alignItems: 'center', gap: 10 }}>
						<span style={{ fontWeight: 500, color: D.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>build local cache{phase === 'building' ? '…' : ''}</span>
						<TargetBadge target="hybrid" />
						<span className="tabular-nums" style={{ fontFamily: MONO, fontSize: 11.5, textAlign: 'right', color: phase === 'building' ? D.lime : D.sub }}>
							{phase === 'building' ? (cache.elapsed != null ? fmtMs(cache.elapsed) : '…') : cacheRecord ? fmtMs(cacheRecord.ms) : cache.elapsed != null ? fmtMs(cache.elapsed) : ''}
						</span>
					</div>
					<div style={{ fontSize: 11, color: D.muted, paddingTop: 3 }}>
						{phase === 'building'
							? `step ${Math.min(cache.done + 1, cache.total)} of ${cache.total} · ${CACHE_STEPS[Math.min(cache.done, cache.total - 1)].label} · panels below still answered by MotherDuck`
							: `ran once when you switched engines · ${cacheRowCount != null ? fmt(cacheRowCount) : '…'} rows · every query below is served from it`}
					</div>
					{phase === 'building' && (
						<div style={{ height: 4, marginTop: 6, background: D.rail, borderRadius: 999, overflow: 'hidden' }}>
							<div style={{ height: 4, width: `${(cache.done / cache.total) * 100}%`, background: D.lime, transition: 'width 200ms' }} />
						</div>
					)}
				</div>
			)}

			{/* trace */}
			<div style={{ marginTop: 12 }}>
				{hidden > 0 && <div style={{ ...eyebrow, color: D.quiet, fontSize: 10, padding: '0 8px 4px' }}>showing the last {TRACE_MAX} of {burstRows.length}</div>}
				{rows.map((q) => {
					const target = targetOf(q.sql);
					const active = shown === q.id;
					return (
						<div
							key={q.id}
							className="trace-row"
							onClick={() => setPinned(q.id)}
							title={`${q.rows.toLocaleString()} rows`}
							style={{ display: 'grid', gridTemplateColumns: '1fr auto 72px 56px', alignItems: 'center', gap: 10, padding: '5px 8px', borderRadius: 6, cursor: 'pointer', background: active ? D.rail : 'transparent' }}
						>
							<span style={{ color: q.error ? D.danger : D.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{q.label}</span>
							<TargetBadge target={target} />
							<span style={{ background: D.rail, borderRadius: 3, height: 7, position: 'relative' }}>
								<span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(2, (q.ms / maxMs) * 100)}%`, background: targetColor(target), opacity: 0.8, borderRadius: 3 }} />
							</span>
							<span className="tabular-nums" style={{ fontFamily: MONO, fontSize: 11.5, color: D.sub, textAlign: 'right' }}>{Math.round(q.ms)} ms</span>
						</div>
					);
				})}
				{running && pending.map((p) => {
					const target = targetOf(p.sql);
					return (
						<div key={`pending-${p.label}`} style={{ display: 'grid', gridTemplateColumns: '1fr auto 72px 56px', alignItems: 'center', gap: 10, padding: '5px 8px', borderRadius: 6, opacity: 0.7 }}>
							<span style={{ color: D.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.label}</span>
							<TargetBadge target={target} />
							<span style={{ background: D.rail, borderRadius: 3, height: 7, position: 'relative', overflow: 'hidden' }}>
								<span className="animate-pulse" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '100%', background: D.lime, opacity: 0.6, borderRadius: 3 }} />
							</span>
							<span className="tabular-nums" style={{ fontFamily: MONO, fontSize: 11.5, color: D.lime, textAlign: 'right' }}>…</span>
						</div>
					);
				})}
			</div>

			{/* sql inspector */}
			{shownSql && (
				<div style={{ marginTop: 12 }}>
					<div className="flex items-baseline justify-between gap-3" style={{ marginBottom: 5 }}>
						<span style={{ ...eyebrow, color: D.muted, fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>generated sql · {shownLabel}</span>
						<span className="shrink-0" style={{ fontSize: 10.5, color: D.quiet, whiteSpace: 'nowrap' }}>click a row to inspect it</span>
					</div>
					<pre style={{ margin: 0, padding: '9px 11px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, fontSize: 10.5, lineHeight: 1.55, color: D.code, fontFamily: MONO, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 150, overflowY: 'auto' }}>
						{shownSql}
					</pre>
				</div>
			)}
			</div>
		</aside>
		</>
	);
}

// ── Duckling size: live size + resize via the `duckling-resize` Flight (admin REST API) ──
// Replace with the id of your own duckling-resize Flight (flights/duckling_resize.py).
const RESIZE_FLIGHT_ID = '00000000-0000-0000-0000-000000000000';
const SIZES = ['pulse', 'standard', 'jumbo', 'mega', 'giga'] as const;
type Size = (typeof SIZES)[number];
const SIZE_LABEL: Record<Size, string> = { pulse: 'Pulse', standard: 'Standard', jumbo: 'Jumbo', mega: 'Mega', giga: 'Giga' };
const RESIZE_POLL_MS = 3000;
const RESIZE_GIVE_UP_MS = 15 * 60_000;
const fmtDur = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`);

function DucklingCard() {
	// Live size of the Duckling serving this Dive. `poll` changes the SQL text so each poll is a fresh query.
	const [poll, setPoll] = useState(0);
	const live = useSQLQuery(`SELECT type, ${poll} AS poll FROM md_live_duckling_size()`);
	const lastLive = useRef<string | null>(null);
	const liveType = Array.isArray(live.data) && live.data[0] ? S((live.data[0] as Row).type) : null;
	if (liveType) lastLive.current = liveType;
	const current = lastLive.current;
	const currentKey = current?.toLowerCase() ?? null;

	const [target, setTarget] = useState<Size | null>(null);
	const [from, setFrom] = useState<string | null>(null);
	const [startedAt, setStartedAt] = useState(0);
	const [doneMs, setDoneMs] = useState<number | null>(null);
	const [gaveUp, setGaveUp] = useState(false);

	const startRun = useRunFlight(RESIZE_FLIGHT_ID);
	const run = useFlightRun(RESIZE_FLIGHT_ID, startRun.data?.runNumber);
	const flightOk = run.status === 'SUCCEEDED';
	const flightFailed = (run.isFinished && !flightOk) || !!startRun.error || !!run.error;
	const reached = target != null && currentKey === target;
	const waiting = target != null && flightOk && !reached && doneMs == null && !gaveUp;
	const busy = target != null && doneMs == null && !flightFailed && !gaveUp;

	// Poll md_live_duckling_size() every few seconds once the Flight has changed the config.
	useEffect(() => {
		if (!waiting || live.isLoading) return;
		if (performance.now() - startedAt > RESIZE_GIVE_UP_MS) { setGaveUp(true); return; }
		const t = setTimeout(() => setPoll((p) => p + 1), RESIZE_POLL_MS);
		return () => clearTimeout(t);
	}, [waiting, live.isLoading, live.data, startedAt]);

	useEffect(() => {
		if (reached && doneMs == null && target != null) setDoneMs(performance.now() - startedAt);
	}, [reached, doneMs, target, startedAt]);

	const elapsed = useStopwatch(busy, startedAt, doneMs ?? 0);

	const choose = (s: Size) => {
		if (busy || s === currentKey) return;
		setTarget(s);
		setFrom(current);
		setStartedAt(performance.now());
		setDoneMs(null);
		setGaveUp(false);
		startRun.run({ SIZE: s });
	};

	const runStatus = startRun.isPending ? 'STARTING' : run.status ?? (startRun.data ? 'PENDING' : null);
	const steps: { label: string; detail: string; state: 'todo' | 'active' | 'ok' | 'failed' }[] = target
		? [
			{
				label: 'flight',
				detail: `duckling-resize · ${(runStatus ?? '…').toLowerCase()}`,
				state: flightOk ? 'ok' : flightFailed ? 'failed' : 'active',
			},
			{
				label: 'admin api',
				detail: `PUT read_write.instance_size = ${target}`,
				state: flightOk ? 'ok' : flightFailed ? 'failed' : 'todo',
			},
			{
				label: 'duckling',
				detail: reached ? `live size is ${SIZE_LABEL[target]}` : gaveUp ? `still ${current ?? '…'} after ${Math.round(RESIZE_GIVE_UP_MS / 60000)} min` : waiting ? `live ${current ?? '…'} · waiting for ${SIZE_LABEL[target]} · poll #${poll}` : 'waiting for the flight',
				state: reached ? 'ok' : gaveUp ? 'failed' : waiting ? 'active' : 'todo',
			},
		]
		: [];
	const stepColor = (s: (typeof steps)[number]['state']) => (s === 'ok' ? D.green : s === 'failed' ? D.danger : s === 'active' ? D.lime : D.quiet);
	const errorText = startRun.error ? `could not start the flight: ${startRun.error.message}` : run.error ? `could not read the flight run: ${run.error.message}` : run.isFinished && !flightOk ? `flight ${String(run.status).toLowerCase()} (exit ${run.exitCode ?? '?'})` : null;

	return (
		<div style={{ marginBottom: 18, padding: '11px 12px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 10 }}>
			<div className="flex items-center justify-between gap-3">
				<div style={{ minWidth: 0 }}>
					<div style={{ ...eyebrow, color: D.muted, fontSize: 10 }}>duckling</div>
					<div className="inline-flex items-center gap-2" style={{ fontFamily: MONO, fontSize: 16, fontWeight: 500, color: D.ink, marginTop: 2 }}>
						<span className={busy ? 'animate-pulse' : undefined} style={{ width: 7, height: 7, borderRadius: 999, background: busy ? D.lime : live.isError ? D.danger : D.green, display: 'inline-block' }} />
						{current ?? (live.isError ? 'unknown' : '…')}
						{busy && target && <span style={{ color: D.lime, fontSize: 12.5 }}>→ {SIZE_LABEL[target]}</span>}
					</div>
				</div>
				<label className="inline-flex items-center gap-2" style={{ fontFamily: MONO, fontSize: 10.5, color: D.muted }}>
					<span style={{ ...eyebrow, color: D.muted, fontSize: 10 }}>resize</span>
					<select
						value={busy && target ? target : currentKey ?? ''}
						disabled={busy || !current}
						onChange={(e) => choose(e.target.value as Size)}
						style={{ fontFamily: MONO, fontSize: 12, color: D.ink, background: D.rail, border: `1px solid ${D.border}`, borderRadius: 6, padding: '4px 8px', cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.6 : 1 }}
					>
						{!current && <option value="">…</option>}
						{SIZES.map((s) => (
							<option key={s} value={s}>{SIZE_LABEL[s]}{s === currentKey ? ' (live)' : ''}</option>
						))}
					</select>
				</label>
			</div>

			{target && (
				<div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${D.border}` }}>
					<div className="flex items-baseline justify-between gap-3" style={{ marginBottom: 5 }}>
						<span style={{ fontSize: 11.5, color: D.sub }}>{from ?? '…'} → {SIZE_LABEL[target]}</span>
						<span className="tabular-nums" style={{ fontFamily: MONO, fontSize: 11.5, color: busy ? D.lime : reached ? D.green : D.sub }}>
							{reached ? `resized in ${fmtDur(doneMs ?? elapsed)}` : fmtDur(elapsed)}
						</span>
					</div>
					{steps.map((s) => (
						<div key={s.label} style={{ display: 'grid', gridTemplateColumns: '12px 66px 1fr', alignItems: 'center', gap: 6, padding: '2px 0' }}>
							<span className={s.state === 'active' ? 'animate-pulse' : undefined} style={{ width: 7, height: 7, borderRadius: 999, background: stepColor(s.state), opacity: s.state === 'todo' ? 0.5 : 1 }} />
							<span style={{ fontFamily: MONO, fontSize: 10.5, color: D.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</span>
							<span style={{ fontFamily: MONO, fontSize: 11, color: s.state === 'todo' ? D.quiet : D.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.detail}</span>
						</div>
					))}
					{errorText && <div role="alert" style={{ marginTop: 6, fontSize: 11, color: D.danger }}>{errorText}</div>}
					{gaveUp && (
						<button
							onClick={() => { setGaveUp(false); setStartedAt(performance.now()); }}
							style={{ marginTop: 6, fontFamily: MONO, fontSize: 11, color: D.ink, background: D.rail, border: `1px solid ${D.border}`, borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}
						>
							keep checking
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function TargetBadge({ target }: { target: Target }) {
	const color = targetColor(target);
	return (
		<span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10.5, color, background: targetWash(target), border: `1px solid ${color}44`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>
			<span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />
			{TARGET_LABEL[target]}
		</span>
	);
}

/** Where the work happens in each phase, and which hop each interaction pays for. Stacked for the narrow rail. */
function FlowDiagram({ width, phase, running, chunksDone, chunks, cacheRows, cacheMs }: {
	width: number;
	phase: Phase;
	running: boolean;
	chunksDone: number;
	chunks: number;
	cacheRows: number | null;
	cacheMs: number | null;
}) {
	const W = width;
	const local = phase === 'local';
	const building = phase === 'building';
	const boxH = 64;
	const cloudY = 22;
	const gap = 60;
	const browserY = cloudY + boxH + gap;
	const H = browserY + boxH + (local ? 52 : 6);
	const topEdge = cloudY + boxH; // bottom of the cloud box
	const botEdge = browserY; // top of the browser box
	const cloudActive = !local;
	const dash = running ? '5 4' : undefined;
	const caption = phase === 'cloud'
		? 'sql out, rows back over the network'
		: building
			? `copying slice ${Math.min(chunksDone + 1, chunks)}/${chunks} · cloud still answers`
			: `CREATE TEMP TABLE · once · ${cacheRows != null ? fmt(cacheRows) : '…'} rows${cacheMs != null ? ` · ${fmtMs(cacheMs)}` : ''}`;
	const captionColor = phase === 'cloud' ? D.cloud : building ? D.lime : D.green;
	const rowsLabel = local ? `temp.main · ${cacheRows != null ? fmt(cacheRows) : '…'} rows in two tables` : building ? 'temp tables · filling…' : 'no local cache';
	// Lanes between the boxes: the cloud round trip on the left pair, the one-time copy on the right.
	const laneSql = W * 0.22;
	const laneRows = W * 0.42;
	const laneCopy = phase === 'cloud' ? W / 2 : W * 0.74;
	return (
		<svg width={W} height={H} style={{ display: 'block', fontFamily: SANS }}>
			<defs>
				{[['hnArrowCloud', D.cloud], ['hnArrowGreen', D.green], ['hnArrowLime', D.lime], ['hnArrowIdle', D.quiet]].map(([id, color]) => (
					<marker key={id} id={id} markerWidth={8} markerHeight={8} refX={7} refY={3.5} orient="auto">
						<path d="M0,0 L7,3.5 L0,7 z" fill={color} />
					</marker>
				))}
			</defs>
			<text x={W / 2} y={11} fontSize={10.5} fill={captionColor} textAnchor="middle" fontFamily={MONO}>{caption}</text>

			{/* MotherDuck — the source */}
			<rect x={0.5} y={cloudY} width={W - 1} height={boxH} rx={8} fill={cloudActive ? D.cloudWash : D.card} stroke={cloudActive ? D.cloud : D.border} strokeWidth={cloudActive ? 1.5 : 1} />
			<text x={14} y={cloudY + 22} fontSize={12} fontWeight={600} fill={cloudActive ? D.ink : D.sub}>MotherDuck · cloud</text>
			<text x={14} y={cloudY + 40} fontSize={11} fill={D.sub}>lakehouse.hn · Apache Iceberg on S3 Tables</text>
			<text x={14} y={cloudY + 56} fontSize={11} fill={cloudActive ? D.cloud : D.quiet}>{local ? 'idle once the cache exists' : 'scans Iceberg on every interaction'}</text>

			{/* cloud round trip: sql down, rows up — still crossing the network while the cache builds */}
			{!local && (
				<>
					<path d={`M ${laneSql} ${topEdge + 2} L ${laneSql} ${botEdge - 9}`} stroke={D.cloud} strokeWidth={2} fill="none" markerEnd="url(#hnArrowCloud)" className={running ? 'flow-dash' : undefined} strokeDasharray={dash} />
					<path d={`M ${laneRows} ${botEdge - 2} L ${laneRows} ${topEdge + 9}`} stroke={D.cloud} strokeWidth={2} fill="none" markerEnd="url(#hnArrowCloud)" className={running ? 'flow-dash' : undefined} strokeDasharray={dash} />
					<text x={laneSql - 8} y={topEdge + gap / 2 + 4} fontSize={10.5} fill={D.cloud} textAnchor="end" fontFamily={MONO}>sql</text>
					<text x={laneRows + 8} y={topEdge + gap / 2 + 4} fontSize={10.5} fill={D.cloud} textAnchor="start" fontFamily={MONO}>rows</text>
				</>
			)}
			{/* the one-time materialisation: cloud scans once, browser keeps the result */}
			{phase !== 'cloud' && (
				<>
					<path
						d={`M ${laneCopy} ${topEdge + 2} L ${laneCopy} ${botEdge - 9}`}
						stroke={building ? D.lime : D.quiet}
						strokeWidth={building ? 3 : 2}
						fill="none"
						markerEnd={building ? 'url(#hnArrowLime)' : 'url(#hnArrowIdle)'}
						className={building ? 'flow-dash' : undefined}
						strokeDasharray={building ? '6 4' : '5 5'}
					/>
					<text x={laneCopy + 10} y={topEdge + gap / 2 + 4} fontSize={10.5} fill={building ? D.lime : D.quiet} textAnchor="start" fontFamily={MONO}>
						{building ? 'copy' : 'copied'}
					</text>
				</>
			)}

			{/* Browser — the consumer */}
			<rect x={0.5} y={browserY} width={W - 1} height={boxH} rx={8} fill={local ? D.greenWash : D.card} stroke={local ? D.green : D.border} strokeWidth={local ? 1.5 : 1} />
			<text x={14} y={browserY + 22} fontSize={12} fontWeight={600} fill={local ? D.green : D.sub}>browser · DuckDB-Wasm</text>
			<text x={14} y={browserY + 40} fontSize={11} fill={D.sub}>{rowsLabel}</text>
			<text x={14} y={browserY + 56} fontSize={11} fill={local ? D.green : D.quiet}>{local ? '⚡ every query runs here' : 'renders only'}</text>

			{/* and from then on the loop never leaves the browser */}
			{local && (
				<>
					<path d={`M ${W / 2 - 34} ${browserY + boxH + 2} q 34 30 68 0`} stroke={D.green} strokeWidth={2} fill="none" markerEnd="url(#hnArrowGreen)" className={running ? 'flow-dash' : undefined} strokeDasharray={dash} />
					<text x={W / 2} y={browserY + boxH + 46} fontSize={10.5} fill={D.green} textAnchor="middle" fontFamily={MONO}>sql + rows · no network</text>
				</>
			)}
		</svg>
	);
}
