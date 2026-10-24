import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Camera,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  MousePointer2,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react';
import {
  ReportRow,
  exportCsv,
  exportExcel,
  activityPercent,
  toDecimalHours,
  toHms,
} from '../lib/exportService';

/* ==========================================================================
   TYPES
========================================================================== */

export interface ReportMember {
  id: string;
  name: string;
  email: string;
}

export interface HistoryRecord {
  dateKey: string; // YYYY-MM-DD
  totalSeconds: number;
  screenshotCount: number;
  // Mouse / keyboard activity totals for the day (desktop agent). Optional:
  // days without agent data have no activity fields (or activityPercent = null).
  activeSeconds?: number;
  trackedSeconds?: number;
  activityPercent?: number | null;
  mouseMoves?: number;
  mouseClicks?: number;
  keyPresses?: number;
}

interface Props {
  /** People that can appear in the report. Employee dashboard passes only self. */
  members: ReportMember[];
  /** Loads all day records of ONE member (called once per member, then cached). */
  loadHistory: (member: ReportMember) => Promise<HistoryRecord[]>;
  /** Admin = true (member picker visible). Employee = false. */
  allowMemberSelect: boolean;
  /** Download file name prefix (no extension). */
  fileName: string;
  title?: string;
}

interface Applied {
  ids: string[];
  from: string;
  to: string;
}

type Metric = 'hours' | 'activity' | 'screenshots';

/* ==========================================================================
   DATE HELPERS (all in local time, keys look like 2026-10-21)
========================================================================== */

const pad = (n: number) => String(n).padStart(2, '0');

const toKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const fromKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

const addDays = (key: string, n: number) => {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
};

const MAX_DAYS = 366;

const enumerateDates = (from: string, to: string): string[] => {
  const out: string[] = [];
  let cur = from;
  while (cur <= to && out.length < MAX_DAYS) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
};

const prettyDate = (key: string, withWeekday = true) =>
  fromKey(key).toLocaleDateString('en-US', {
    weekday: withWeekday ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

const shortDate = (key: string) =>
  fromKey(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const PRESETS: { label: string; range: () => [string, string] }[] = [
  {
    label: 'Today',
    range: () => {
      const t = toKey(new Date());
      return [t, t];
    },
  },
  {
    label: 'Yesterday',
    range: () => {
      const y = addDays(toKey(new Date()), -1);
      return [y, y];
    },
  },
  {
    label: 'Last 7 days',
    range: () => {
      const t = toKey(new Date());
      return [addDays(t, -6), t];
    },
  },
  {
    label: 'This week',
    range: () => {
      const t = new Date();
      const monday = addDays(toKey(t), -((t.getDay() + 6) % 7));
      return [monday, addDays(monday, 6)];
    },
  },
  {
    label: 'This month',
    range: () => {
      const t = new Date();
      return [
        toKey(new Date(t.getFullYear(), t.getMonth(), 1)),
        toKey(new Date(t.getFullYear(), t.getMonth() + 1, 0)),
      ];
    },
  },
  {
    label: 'Last month',
    range: () => {
      const t = new Date();
      return [
        toKey(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
        toKey(new Date(t.getFullYear(), t.getMonth(), 0)),
      ];
    },
  },
];

// Default dates in the filter box = Today.
const defaultRange = (): [string, string] => PRESETS[0].range();

// false = only the filter box is visible; the report (cards, chart, table)
// appears after the user clicks Apply or a Today / Week / Month button.
// Set to true if you want data to be shown immediately when the page opens.
const SHOW_REPORT_ON_LOAD = false;

const fmtHm = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}`;
};

/** Pick a "nice" axis step so there are about 4-6 grid lines. */
const niceStep = (max: number) => {
  const steps = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  return steps.find((s) => max / s <= 5) ?? 1000;
};

const slug = (s: string) => s.trim().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');

/* ==========================================================================
   COMPONENT
========================================================================== */

export const TimeActivityReport: React.FC<Props> = ({
  members,
  loadHistory,
  allowMemberSelect,
  fileName,
  title = 'Time and activity report',
}) => {
  const memberKey = members.map((m) => m.id).join('|');
  const membersById = useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberKey]
  );

  const [initialFrom, initialTo] = useMemo(defaultRange, []);

  // Draft = what the user is editing. Applied = what the report shows.
  const [draftIds, setDraftIds] = useState<string[]>(members.map((m) => m.id));
  const [draftFrom, setDraftFrom] = useState(initialFrom);
  const [draftTo, setDraftTo] = useState(initialTo);
  const [applied, setApplied] = useState<Applied>({
    ids: members.map((m) => m.id),
    from: initialFrom,
    to: initialTo,
  });
  const touchedMembers = useRef(false);
  const [shown, setShown] = useState(SHOW_REPORT_ON_LOAD);

  // When the member list arrives/changes and the user has not picked anyone
  // yet, select everybody (this is the "All members" default).
  useEffect(() => {
    if (touchedMembers.current) {
      const valid = new Set(members.map((m) => m.id));
      setDraftIds((prev) => prev.filter((id) => valid.has(id)));
      setApplied((prev) => ({ ...prev, ids: prev.ids.filter((id) => valid.has(id)) }));
      return;
    }
    const all = members.map((m) => m.id);
    setDraftIds(all);
    setApplied((prev) => ({ ...prev, ids: all }));
  }, [memberKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [cache, setCache] = useState<Record<string, HistoryRecord[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  // Keep the latest loader in a ref so parent re-renders do not retrigger loads.
  const loadRef = useRef(loadHistory);
  loadRef.current = loadHistory;

  const [metric, setMetric] = useState<Metric>('hours');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  /* ---------------------------- data loading ---------------------------- */

  const fetchMembers = useCallback(
    async (ids: string[], force: boolean) => {
      const todo = ids.filter((id) => force || !cacheRef.current[id]);
      if (!todo.length) return;

      const myRequest = ++requestRef.current;
      setLoading(true);
      setError('');

      const results: Record<string, HistoryRecord[]> = {};
      let failed = 0;
      let firstError = '';
      let next = 0;

      // Small worker pool so 50 employees do not fire 50 requests at once.
      const worker = async () => {
        while (next < todo.length) {
          const id = todo[next++];
          const member = membersById.get(id);
          if (!member) continue;
          try {
            results[id] = await loadRef.current(member);
          } catch (e: any) {
            failed += 1;
            if (!firstError) firstError = e?.message || 'Request failed';
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));

      if (myRequest !== requestRef.current) return; // a newer request took over

      setCache((prev) => ({ ...prev, ...results }));
      if (failed) {
        setError(
          `Could not load ${failed} of ${todo.length} member(s): ${firstError}`
        );
      }
      setLoading(false);
    },
    [membersById]
  );

  // First load (and whenever the member list changes): fetch what is missing.
  useEffect(() => {
    if (shown) void fetchMembers(applied.ids, false);
  }, [memberKey, fetchMembers]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ----------------------------- apply logic ---------------------------- */

  // Which quick button (Today / This week ...) matches the range on screen.
  const activePreset = shown
    ? PRESETS.find((p) => {
        const [f, t] = p.range();
        return f === applied.from && t === applied.to;
      })?.label
    : undefined;

  const rangeInvalid = !draftFrom || !draftTo || draftFrom > draftTo;
  const noMembers = draftIds.length === 0;

  const apply = () => {
    if (rangeInvalid || noMembers) return;
    const ids = [...draftIds];
    setApplied({ ids, from: draftFrom, to: draftTo });
    setShown(true);
    setHoverIdx(null);
    void fetchMembers(ids, true); // Apply always pulls the latest numbers
  };

  const applyPreset = (range: [string, string]) => {
    setDraftFrom(range[0]);
    setDraftTo(range[1]);
    const ids = draftIds.length ? [...draftIds] : applied.ids;
    setApplied({ ids, from: range[0], to: range[1] });
    setShown(true);
    setHoverIdx(null);
    void fetchMembers(ids, true);
  };

  /* ----------------------------- derived data --------------------------- */

  const rows: ReportRow[] = useMemo(() => {
    const out: ReportRow[] = [];
    applied.ids.forEach((id) => {
      const m = membersById.get(id);
      if (!m) return;
      (cache[id] || []).forEach((r) => {
        if (r.dateKey < applied.from || r.dateKey > applied.to) return;
        const seconds = Math.max(0, Number(r.totalSeconds) || 0);
        const shots = Math.max(0, Number(r.screenshotCount) || 0);
        const tracked = Math.max(0, Number(r.trackedSeconds) || 0);
        if (seconds === 0 && shots === 0 && tracked === 0) return;
        out.push({
          employeeName: m.name,
          email: m.email,
          date: r.dateKey,
          totalSeconds: seconds,
          screenshots: shots,
          activeSeconds: Math.max(0, Number(r.activeSeconds) || 0),
          trackedSeconds: tracked,
          mouseMoves: Math.max(0, Number(r.mouseMoves) || 0),
          mouseClicks: Math.max(0, Number(r.mouseClicks) || 0),
          keyPresses: Math.max(0, Number(r.keyPresses) || 0),
        });
      });
    });
    return out.sort(
      (a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName)
    );
  }, [cache, applied, membersById]);

  const days = useMemo(() => {
    const map = new Map<
      string,
      { seconds: number; shots: number; active: number; tracked: number; rows: ReportRow[] }
    >();
    rows.forEach((r) => {
      const d = map.get(r.date) || { seconds: 0, shots: 0, active: 0, tracked: 0, rows: [] };
      d.seconds += r.totalSeconds;
      d.shots += r.screenshots;
      d.active += r.activeSeconds || 0;
      d.tracked += r.trackedSeconds || 0;
      d.rows.push(r);
      map.set(r.date, d);
    });
    return map;
  }, [rows]);

  const allDates = useMemo(
    () => enumerateDates(applied.from, applied.to),
    [applied.from, applied.to]
  );

  const totalSeconds = rows.reduce((s, r) => s + r.totalSeconds, 0);
  const totalShots = rows.reduce((s, r) => s + r.screenshots, 0);
  const activeDays = Array.from(days.values()).filter((d) => d.seconds > 0).length;
  const avgSeconds = activeDays ? totalSeconds / activeDays : 0;
  // Weighted over the whole selection: total active seconds / total tracked seconds.
  const totalActive = rows.reduce((s, r) => s + (r.activeSeconds || 0), 0);
  const totalTracked = rows.reduce((s, r) => s + (r.trackedSeconds || 0), 0);
  const avgActivity = activityPercent(totalActive, totalTracked); // null = no agent data

  const tableDates = useMemo(() => {
    const keys = Array.from(days.keys()).sort();
    return newestFirst ? keys.reverse() : keys;
  }, [days, newestFirst]);

  /* ------------------------------- chart -------------------------------- */

  const chart = useMemo(() => {
    const values = allDates.map((d) => {
      const day = days.get(d);
      if (metric === 'activity') return activityPercent(day?.active, day?.tracked) ?? 0;
      return metric === 'hours' ? (day?.seconds || 0) / 3600 : day?.shots || 0;
    });
    if (metric === 'activity') {
      return { values, top: 100, ticks: [0, 25, 50, 75, 100] };
    }
    const rawMax = Math.max(0, ...values);
    const step = metric === 'hours' ? niceStep(rawMax || 1) : Math.max(1, niceStep(rawMax || 1));
    const top = Math.max(step, Math.ceil(rawMax / step) * step);
    const ticks: number[] = [];
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
    return { values, top, ticks };
  }, [allDates, days, metric]);

  const W = 1000;
  const H = 280;
  const PL = 52;
  const PR = 12;
  const PT = 12;
  const PB = 34;
  const innerW = W - PL - PR;
  const innerH = H - PT - PB;
  const slot = innerW / Math.max(1, allDates.length);
  const barW = Math.max(3, Math.min(48, slot * 0.6));
  const labelEvery = Math.max(1, Math.ceil(allDates.length / 10));

  const fmtTick = (v: number) =>
    metric === 'hours'
      ? `${Math.floor(v)}:${pad(Math.round((v - Math.floor(v)) * 60))}`
      : metric === 'activity'
      ? `${v}%`
      : String(v);

  // Text used for the hover line and bar tooltip, per metric.
  const metricText = (dateKey: string) => {
    const day = days.get(dateKey);
    if (metric === 'activity') {
      const pct = activityPercent(day?.active, day?.tracked);
      return pct === null ? 'no activity data' : `${pct}% activity`;
    }
    return metric === 'hours' ? toHms(day?.seconds || 0) : `${day?.shots || 0} screenshots`;
  };

  /* ------------------------------ downloads ----------------------------- */

  const exportName = useMemo(() => {
    const who =
      allowMemberSelect && applied.ids.length === 1
        ? `_${slug(membersById.get(applied.ids[0])?.name || 'member')}`
        : allowMemberSelect && applied.ids.length === members.length
        ? '_all-members'
        : allowMemberSelect
        ? `_${applied.ids.length}-members`
        : '';
    return `${fileName}${who}_${applied.from}_to_${applied.to}`;
  }, [allowMemberSelect, applied, fileName, members.length, membersById]);

  const download = async (kind: 'csv' | 'xlsx') => {
    if (!rows.length) {
      setError('No data to download for the selected members and dates.');
      return;
    }
    try {
      setBusy(true);
      if (kind === 'csv') exportCsv(rows, exportName);
      else await exportExcel(rows, exportName);
    } catch (e) {
      console.error(e);
      setError('Download failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------ UI pieces ----------------------------- */

  const card =
    'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl';
  const inputCls =
    'border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-sm';

  const hoverDate = hoverIdx !== null ? allDates[hoverIdx] : null;

  return (
    <div className="space-y-4">
      {/* ------------------------------ header ------------------------------ */}
      <div className={`${card} p-4 space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-light text-slate-800 dark:text-slate-100">
            {title}
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!shown || busy || loading}
              onClick={() => download('csv')}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-indigo-600 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" /> CSV
            </button>
            <button
              type="button"
              disabled={!shown || busy || loading}
              onClick={() => download('xlsx')}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" /> Excel
            </button>
            <button
              type="button"
              disabled={!shown || loading}
              title="Reload latest data"
              onClick={() => void fetchMembers(applied.ids, true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-slate-300 dark:border-slate-700 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* filters: members + dates + Apply */}
        <div className="flex flex-wrap items-end gap-3">
          {allowMemberSelect && (
            <MemberPicker
              members={members}
              selected={draftIds}
              onChange={(ids) => {
                touchedMembers.current = true;
                setDraftIds(ids);
              }}
            />
          )}

          <label className="text-[11px] font-bold uppercase text-slate-500">
            From
            <input
              type="date"
              value={draftFrom}
              max={draftTo || undefined}
              onChange={(e) => setDraftFrom(e.target.value)}
              className={`${inputCls} block mt-1`}
            />
          </label>

          <label className="text-[11px] font-bold uppercase text-slate-500">
            To
            <input
              type="date"
              value={draftTo}
              min={draftFrom || undefined}
              onChange={(e) => setDraftTo(e.target.value)}
              className={`${inputCls} block mt-1`}
            />
          </label>

          <button
            type="button"
            onClick={apply}
            disabled={rangeInvalid || noMembers}
            className="px-5 py-2 rounded-lg text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Apply
          </button>

          <div className="flex flex-wrap gap-1.5 pb-0.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                aria-pressed={activePreset === p.label}
                onClick={() => applyPreset(p.range())}
                className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-colors ${
                  activePreset === p.label
                    ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                    : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-500 hover:text-indigo-600'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {(rangeInvalid || noMembers) && (
          <div className="text-xs text-amber-600">
            {noMembers
              ? 'Select at least one member.'
              : 'Please choose a valid From / To date (From must not be after To).'}
          </div>
        )}

        <div className="text-[11px] text-slate-500">
          {shown ? (
            <>
              Showing {prettyDate(applied.from, false)} – {prettyDate(applied.to, false)}
              {allowMemberSelect &&
                ` · ${
                  applied.ids.length === members.length
                    ? 'All members'
                    : `${applied.ids.length} of ${members.length} members`
                }`}
            </>
          ) : (
            'Choose Today, This week or This month (or pick dates and click Apply) to see the report.'
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 text-red-700 dark:text-red-300 text-xs px-4 py-3">
          {error}
        </div>
      )}

      {shown && (
        <>
      {/* ----------------------------- summary cards ---------------------------- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard icon={<Clock className="w-5 h-5" />} label="Total time" value={toHms(totalSeconds)} />
        <SummaryCard
          icon={<MousePointer2 className="w-5 h-5" />}
          label="Average activity"
          value={avgActivity === null ? '–' : `${avgActivity}%`}
        />
        <SummaryCard icon={<Camera className="w-5 h-5" />} label="Screenshots" value={String(totalShots)} />
        <SummaryCard
          icon={<Users className="w-5 h-5" />}
          label={`Average per active day (${activeDays} day${activeDays === 1 ? '' : 's'})`}
          value={toHms(avgSeconds)}
        />
      </div>

      {/* --------------------------------- chart --------------------------------- */}
      <div className={`${card} p-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="font-bold text-slate-700 dark:text-slate-200">Chart</div>

          <div className="flex items-center gap-3">
            <div className="text-xs text-slate-500 min-h-[1rem]">
              {hoverDate
                ? `${prettyDate(hoverDate)} — ${metricText(hoverDate)}`
                : 'Hover a bar for details'}
            </div>

            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as Metric)}
              className={`${inputCls} py-1.5 text-xs`}
            >
              <option value="hours">Total hours</option>
              <option value="activity">Activity %</option>
              <option value="screenshots">Screenshots</option>
            </select>
          </div>
        </div>

        {loading && !rows.length ? (
          <div className="py-16 text-center text-sm text-slate-500">Loading report…</div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-auto"
            role="img"
            aria-label="Bar chart of tracked time per day"
            onMouseLeave={() => setHoverIdx(null)}
          >
            {chart.ticks.map((t) => {
              const y = PT + innerH - (t / chart.top) * innerH;
              return (
                <g key={t}>
                  <line x1={PL} x2={W - PR} y1={y} y2={y} className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />
                  <text x={PL - 8} y={y + 4} textAnchor="end" className="fill-slate-500" fontSize={11}>
                    {fmtTick(t)}
                  </text>
                </g>
              );
            })}

            {allDates.map((d, i) => {
              const v = chart.values[i];
              const h = (v / chart.top) * innerH;
              const x = PL + slot * i + (slot - barW) / 2;
              const y = PT + innerH - h;
              return (
                <g key={d} onMouseEnter={() => setHoverIdx(i)}>
                  {/* wide invisible hit area so thin bars are easy to hover */}
                  <rect x={PL + slot * i} y={PT} width={slot} height={innerH} fill="transparent" />
                  {v > 0 && (
                    <rect
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(2, h)}
                      rx={2}
                      className={hoverIdx === i ? 'fill-indigo-700' : 'fill-indigo-500'}
                    >
                      <title>
                        {prettyDate(d)}: {metricText(d)}
                      </title>
                    </rect>
                  )}
                  {i % labelEvery === 0 && (
                    <text
                      x={PL + slot * i + slot / 2}
                      y={H - 12}
                      textAnchor="middle"
                      className="fill-slate-500"
                      fontSize={11}
                    >
                      {allDates.length <= 8 ? prettyDate(d) : shortDate(d)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* --------------------------------- table --------------------------------- */}
      <div className={`${card} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300">
              <tr className="text-left">
                <th className="p-3 w-8" />
                <th className="p-3">
                  <button
                    type="button"
                    onClick={() => setNewestFirst((v) => !v)}
                    className="font-bold inline-flex items-center gap-1"
                    title="Click to change sort order"
                  >
                    Date {newestFirst ? '↓' : '↑'}
                  </button>
                </th>
                {allowMemberSelect && <th className="p-3">Members</th>}
                <th className="p-3">Total hours</th>
                <th className="p-3">Decimal hours</th>
                <th className="p-3">Activity</th>
                <th className="p-3">Screenshots</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {tableDates.map((d) => {
                const day = days.get(d)!;
                const canExpand = allowMemberSelect;
                const open = !!expanded[d];
                return (
                  <React.Fragment key={d}>
                    <tr
                      className={canExpand ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40' : ''}
                      onClick={() => canExpand && setExpanded((p) => ({ ...p, [d]: !p[d] }))}
                    >
                      <td className="p-3 text-slate-400">
                        {canExpand &&
                          (open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />)}
                      </td>
                      <td className="p-3 font-medium">{prettyDate(d)}</td>
                      {allowMemberSelect && <td className="p-3">{day.rows.length}</td>}
                      <td className="p-3 font-mono">{toHms(day.seconds)}</td>
                      <td className="p-3">{toDecimalHours(day.seconds)}</td>
                      <td className="p-3">
                        <ActivityCell
                          percent={activityPercent(day.active, day.tracked)}
                          title={activityTitle(day.rows)}
                        />
                      </td>
                      <td className="p-3">{day.shots}</td>
                    </tr>

                    {canExpand &&
                      open &&
                      day.rows.map((r) => (
                        <tr key={`${d}-${r.email}-${r.employeeName}`} className="bg-slate-50/70 dark:bg-slate-800/30 text-slate-600 dark:text-slate-300">
                          <td />
                          <td className="p-3 pl-6 text-xs" colSpan={2}>
                            {r.employeeName}
                            <span className="text-slate-400"> · {r.email}</span>
                          </td>
                          <td className="p-3 font-mono text-xs">{toHms(r.totalSeconds)}</td>
                          <td className="p-3 text-xs">{toDecimalHours(r.totalSeconds)}</td>
                          <td className="p-3 text-xs">
                            <ActivityCell
                              percent={activityPercent(r.activeSeconds, r.trackedSeconds)}
                              title={activityTitle([r])}
                            />
                          </td>
                          <td className="p-3 text-xs">{r.screenshots}</td>
                        </tr>
                      ))}
                  </React.Fragment>
                );
              })}

              {!tableDates.length && (
                <tr>
                  <td
                    colSpan={allowMemberSelect ? 7 : 6}
                    className="p-8 text-center text-slate-500"
                  >
                    {loading ? 'Loading report…' : 'No tracked time found for this selection.'}
                  </td>
                </tr>
              )}
            </tbody>

            {tableDates.length > 0 && (
              <tfoot className="bg-slate-50 dark:bg-slate-800/60 font-bold">
                <tr>
                  <td />
                  <td className="p-3">Total</td>
                  {allowMemberSelect && <td />}
                  <td className="p-3 font-mono">{toHms(totalSeconds)}</td>
                  <td className="p-3">{toDecimalHours(totalSeconds)}</td>
                  <td className="p-3">
                    <ActivityCell percent={avgActivity} title={activityTitle(rows)} />
                  </td>
                  <td className="p-3">{totalShots}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="px-4 py-3 text-xs text-slate-500 border-t border-slate-100 dark:border-slate-800">
          Showing {tableDates.length} day{tableDates.length === 1 ? '' : 's'} with tracked data
          {fmtHm(totalSeconds) !== '0:00' && ` · ${fmtHm(totalSeconds)} hours in total`}
        </div>
      </div>
        </>
      )}
    </div>
  );
};

/* ==========================================================================
   SMALL PIECES
========================================================================== */

/** Tooltip text with the raw mouse / keyboard counts of the given rows. */
const activityTitle = (rows: ReportRow[]): string => {
  const tracked = rows.reduce((s, r) => s + (r.trackedSeconds || 0), 0);
  if (tracked <= 0) return 'No mouse/keyboard data (activity agent was not running)';
  const sum = (key: 'mouseMoves' | 'mouseClicks' | 'keyPresses') =>
    rows.reduce((s, r) => s + (r[key] || 0), 0);
  return `${sum('mouseMoves')} mouse moves · ${sum('mouseClicks')} clicks · ${sum('keyPresses')} key presses`;
};

/** Activity % with a small coloured bar. null = no agent data, shown as a dash. */
const ActivityCell: React.FC<{ percent: number | null; title?: string }> = ({ percent, title }) => {
  if (percent === null) {
    return (
      <span className="text-slate-400" title={title}>
        –
      </span>
    );
  }
  const color =
    percent === 0 ? 'bg-slate-400' : percent <= 25 ? 'bg-rose-500' : percent <= 55 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-2 min-w-[96px]" title={title}>
      <div className="h-1.5 w-14 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="tabular-nums">{percent}%</span>
    </div>
  );
};

const SummaryCard: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({
  icon,
  label,
  value,
}) => (
  <div className="flex items-center gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4">
    <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 flex items-center justify-center shrink-0">
      {icon}
    </div>
    <div className="min-w-0">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-bold text-slate-800 dark:text-slate-100 truncate">{value}</div>
    </div>
  </div>
);

/** Dropdown with search, Select all / Unselect all and "show only selected". */
const MemberPicker: React.FC<{
  members: ReportMember[];
  selected: string[];
  onChange: (ids: string[]) => void;
}> = ({ members, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sel = new Set(selected);
  const q = query.trim().toLowerCase();
  const visible = members.filter(
    (m) =>
      (!onlySelected || sel.has(m.id)) &&
      (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
  );

  const label =
    members.length > 0 && selected.length === members.length
      ? 'All members'
      : selected.length === 1
      ? members.find((m) => m.id === selected[0])?.name || '1 member'
      : selected.length === 0
      ? 'No members'
      : `${selected.length} members`;

  const toggle = (id: string) =>
    onChange(sel.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="relative" ref={boxRef}>
      <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">Members</div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-between gap-2 min-w-[170px] border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-sm"
      >
        <span className="truncate max-w-[160px]">{label}</span>
        <ChevronDown className="w-4 h-4 text-slate-500" />
      </button>

      {open && (
        <div className="absolute z-30 mt-2 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl">
          <div className="p-3 border-b border-slate-100 dark:border-slate-800">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search members"
                className="w-full pl-9 pr-3 py-2 text-sm rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
              />
            </div>
          </div>

          <div className="flex justify-between px-4 py-2 text-xs font-semibold text-indigo-600">
            <button type="button" onClick={() => onChange(members.map((m) => m.id))}>
              Select all
            </button>
            <button type="button" onClick={() => onChange([])}>
              Unselect all
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto border-t border-slate-100 dark:border-slate-800">
            {visible.map((m) => (
              <label
                key={m.id}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={sel.has(m.id)}
                  onChange={() => toggle(m.id)}
                  className="w-4 h-4 accent-indigo-600"
                />
                <span className="min-w-0">
                  <span className="block text-sm truncate">{m.name}</span>
                  <span className="block text-[11px] text-slate-500 truncate">{m.email}</span>
                </span>
              </label>
            ))}
            {!visible.length && (
              <div className="px-4 py-6 text-center text-xs text-slate-500">No members found</div>
            )}
          </div>

          <label className="flex items-center justify-between px-4 py-3 border-t border-slate-100 dark:border-slate-800 text-[11px] font-bold uppercase text-slate-500 cursor-pointer">
            Show only selected
            <input
              type="checkbox"
              checked={onlySelected}
              onChange={(e) => setOnlySelected(e.target.checked)}
              className="w-4 h-4 accent-indigo-600"
            />
          </label>
        </div>
      )}
    </div>
  );
};
