import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Mail,
  RefreshCw,
  Send,
  XCircle,
} from 'lucide-react';
import { apiFetch } from '../lib/api';

/* ==========================================================================
   Email report card
   - mode "admin"   : Admin can e-mail the report of ALL employees or of ONE
                      employee to his own login e-mail, and sees the history
                      of automatic (Friday) and manual e-mails.
   - mode "employee": an employee can e-mail his OWN report to his own login
                      e-mail.
   Date range: preset (today, yesterday ...) or custom start/end date,
   maximum 90 days.
========================================================================== */

const MAX_DAYS = 90;

// The history table (automatic + manual sends) is hidden for now.
// Set to true to show it again. The Worker keeps writing the log either way.
const SHOW_HISTORY = false;

type PresetKey =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'custom';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This week' },
  { key: 'last_week', label: 'Last week' },
  { key: 'this_month', label: 'Current month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'custom', label: 'Custom range' },
];

type Member = { id: string; name: string; email?: string };

type LogRow = {
  id: number;
  period: string;
  range_from: string | null;
  range_to: string | null;
  trigger_type: 'auto' | 'manual';
  status: 'sent' | 'failed' | 'skipped';
  recipients: string | null;
  employees: number | null;
  rows_count: number | null;
  error: string | null;
  created_at: string;
  scope: string | null;
};

type Settings = {
  emailConfigured: boolean;
  recipients?: string[];
  dailyEnabled?: boolean;
  weeklySchedule?: string;
  dailySchedule?: string;
  nextWeeklyRun?: string;
};

type Props = {
  mode: 'admin' | 'employee';
  currentUser: { id: string; name: string; email: string };
  members?: Member[];
};

/* ------------------------------ date helpers ----------------------------- */

// "YYYY-MM-DD" in India time (the server uses the same day boundaries).
const todayKey = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const toUtc = (key: string): Date => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const addDays = (key: string, days: number): string =>
  new Date(toUtc(key).getTime() + days * 86400000)
    .toISOString()
    .slice(0, 10);

const daysBetween = (from: string, to: string): number =>
  Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86400000);

const rangeForPreset = (
  preset: Exclude<PresetKey, 'custom'>
): { from: string; to: string } => {
  const today = todayKey();
  const dow = toUtc(today).getUTCDay(); // 0 = Sunday
  const monday = addDays(today, -(dow === 0 ? 6 : dow - 1));
  const monthStart = `${today.slice(0, 8)}01`;

  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'this_week':
      return { from: monday, to: today };
    case 'last_week':
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'this_month':
      return { from: monthStart, to: today };
    case 'last_month': {
      const lastDay = addDays(monthStart, -1);
      return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
    }
  }
};

const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/* --------------------------------- styles -------------------------------- */

const card =
  'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl';
const inputCls =
  'border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-sm';
const labelCls = 'text-[11px] font-bold uppercase text-slate-500';

/* -------------------------------- component ------------------------------ */

export const EmailReportCard: React.FC<Props> = ({
  mode,
  currentUser,
  members = [],
}) => {
  const isAdmin = mode === 'admin';
  const today = todayKey();

  const [preset, setPreset] = useState<PresetKey>('this_week');
  const [from, setFrom] = useState<string>(rangeForPreset('this_week').from);
  const [to, setTo] = useState<string>(rangeForPreset('this_week').to);
  const [employeeId, setEmployeeId] = useState<string>('all');

  const [logs, setLogs] = useState<LogRow[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  /* ------------------------------- validation ----------------------------- */

  const rangeError = useMemo(() => {
    if (!from || !to) return 'Please select a start date and an end date.';
    if (from > to) return 'The start date must be before the end date.';
    if (to > today) return 'The end date cannot be in the future.';
    if (daysBetween(from, to) + 1 > MAX_DAYS) {
      return `You can select a maximum of ${MAX_DAYS} days.`;
    }
    return '';
  }, [from, to, today]);

  const dayCount =
    from && to && from <= to ? daysBetween(from, to) + 1 : 0;

  /* --------------------------------- loading ------------------------------ */

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = isAdmin
        ? '/api/admin/report-log'
        : `/api/employee/report-log?employeeId=${encodeURIComponent(currentUser.id)}`;

      const res = await apiFetch(endpoint, {
        method: 'GET',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to load the email report history.');
      }

      setLogs(Array.isArray(data.logs) ? data.logs : []);
      setSettings(data.settings || null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load the email report history.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, currentUser.id]);

  useEffect(() => {
    load();
  }, [load]);

  /* ---------------------------- range controls ---------------------------- */

  const onPresetChange = (value: PresetKey) => {
    setPreset(value);
    setError('');
    setNotice('');

    if (value !== 'custom') {
      const r = rangeForPreset(value);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  const onFromChange = (value: string) => {
    setPreset('custom');
    setFrom(value);
    setError('');
    setNotice('');

    if (value && to) {
      if (to < value) setTo(value);
      else if (daysBetween(value, to) + 1 > MAX_DAYS) {
        setTo(addDays(value, MAX_DAYS - 1) > today ? today : addDays(value, MAX_DAYS - 1));
      }
    }
  };

  const onToChange = (value: string) => {
    setPreset('custom');
    setTo(value);
    setError('');
    setNotice('');
  };

  /* --------------------------------- sending ------------------------------ */

  const sendNow = async () => {
    if (rangeError) return;

    setSending(true);
    setError('');
    setNotice('');

    try {
      const res = await apiFetch(
        isAdmin ? '/api/admin/send-report' : '/api/employee/send-report',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            isAdmin
              ? { adminEmail: currentUser.email, employeeId, from, to }
              : { employeeId: currentUser.id, from, to }
          ),
        }
      );
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to send the report.');
      }

      setNotice(
        `Report (${data.from === data.to ? data.from : `${data.from} to ${data.to}`}) was sent to ${currentUser.email}.`
      );
    } catch (e: any) {
      setError(e?.message || 'Failed to send the report.');
    } finally {
      setSending(false);
      load();
    }
  };

  const selectedMember = members.find((m) => m.id === employeeId);

  /* ---------------------------------- view -------------------------------- */

  const lastSent = logs.find((l) => l.status === 'sent' && l.trigger_type === 'auto');

  return (
    <div className={`${card} p-4 space-y-4 mb-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Mail className="w-5 h-5 text-indigo-600" />
          <h2 className="text-xl font-light text-slate-800 dark:text-slate-100">
            {isAdmin ? 'Email Reports' : 'Email my report'}
          </h2>
        </div>

        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-slate-300 dark:border-slate-700 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {isAdmin && settings && (
        <div className="grid gap-2 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-2">
          <div>
            <span className={labelCls}>Last automatic report: </span>
            {lastSent ? fmtDateTime(lastSent.created_at) : 'Not sent yet'}
          </div>
          <div>
            <span className={labelCls}>Next automatic report: </span>
            {fmtDateTime(settings.nextWeeklyRun)}
          </div>
          <div>
            <span className={labelCls}>Schedule: </span>
            Weekly - {settings.weeklySchedule}
            {settings.dailyEnabled
              ? `; Daily - ${settings.dailySchedule}`
              : '; Daily is off'}
          </div>
          <div>
            <span className={labelCls}>Automatic reports go to: </span>
            {settings.recipients?.length
              ? settings.recipients.join(', ')
              : 'No recipient configured'}
          </div>
        </div>
      )}

      {settings && !settings.emailConfigured && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 text-amber-700 dark:text-amber-300 text-xs px-4 py-3">
          The email service is not configured yet (MAIL_RELAY_URL or
          RESEND_API_KEY is missing), so reports cannot be sent.
        </div>
      )}

      {/* ----------------------------- send form ----------------------------- */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3">
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Send a report to my email
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {isAdmin && (
            <label className={labelCls}>
              Employee
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className={`${inputCls} block mt-1 min-w-[180px]`}
              >
                <option value="all">All employees</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className={labelCls}>
            Period
            <select
              value={preset}
              onChange={(e) => onPresetChange(e.target.value as PresetKey)}
              className={`${inputCls} block mt-1 min-w-[160px]`}
            >
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className={labelCls}>
            From
            <input
              type="date"
              value={from}
              max={to && to < today ? to : today}
              onChange={(e) => onFromChange(e.target.value)}
              className={`${inputCls} block mt-1`}
            />
          </label>

          <label className={labelCls}>
            To
            <input
              type="date"
              value={to}
              min={from || undefined}
              max={
                from && addDays(from, MAX_DAYS - 1) < today
                  ? addDays(from, MAX_DAYS - 1)
                  : today
              }
              onChange={(e) => onToChange(e.target.value)}
              className={`${inputCls} block mt-1`}
            />
          </label>

          <button
            type="button"
            onClick={sendNow}
            disabled={sending || Boolean(rangeError)}
            className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
            {sending ? 'Sending...' : 'Send to my email'}
          </button>
        </div>

        <div className="text-[11px] text-slate-500">
          {dayCount > 0 ? `${dayCount} day${dayCount === 1 ? '' : 's'} selected. ` : ''}
          Maximum {MAX_DAYS} days.{' '}
          {isAdmin
            ? `The ${selectedMember ? `report of ${selectedMember.name}` : 'report of all employees'} will be emailed to ${currentUser.email}.`
            : `Your report will be emailed to ${currentUser.email}.`}
        </div>

        {rangeError && (
          <div className="text-xs text-amber-600">{rangeError}</div>
        )}
      </div>

      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300 text-xs px-4 py-3">
          {notice}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 text-red-700 dark:text-red-300 text-xs px-4 py-3">
          {error}
        </div>
      )}

      {/* ------------------------------ history ------------------------------ */}
      {SHOW_HISTORY && (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[11px] uppercase text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2 pr-3">When</th>
              {isAdmin && <th className="py-2 pr-3">Type</th>}
              {isAdmin && <th className="py-2 pr-3">Employee</th>}
              <th className="py-2 pr-3">Period</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr>
                <td
                  colSpan={isAdmin ? 6 : 4}
                  className="py-4 text-center text-slate-500"
                >
                  No email report has been sent yet.
                </td>
              </tr>
            )}

            {logs.map((l) => (
              <tr
                key={l.id}
                className="border-b border-slate-100 dark:border-slate-800/60 align-top"
              >
                <td className="py-2 pr-3 whitespace-nowrap">
                  {fmtDateTime(l.created_at)}
                </td>
                {isAdmin && (
                  <td className="py-2 pr-3">
                    {l.trigger_type === 'manual' ? 'Manual' : 'Automatic'}
                  </td>
                )}
                {isAdmin && (
                  <td className="py-2 pr-3">{l.scope || 'All employees'}</td>
                )}
                <td className="py-2 pr-3 whitespace-nowrap">
                  {l.range_from === l.range_to
                    ? l.range_from
                    : `${l.range_from} to ${l.range_to}`}
                </td>
                <td className="py-2 pr-3">
                  {l.status === 'sent' ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Sent
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-red-600 font-semibold">
                      <XCircle className="w-3.5 h-3.5" /> Failed
                    </span>
                  )}
                </td>
                <td className="py-2 text-slate-600 dark:text-slate-300 break-words">
                  {l.status === 'sent'
                    ? l.recipients || ''
                    : l.error || 'Unknown error'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
};
