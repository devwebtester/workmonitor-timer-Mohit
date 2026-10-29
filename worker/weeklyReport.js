// ======================================================================
// Scheduled Daily / Weekly e-mail report (Cloudflare Worker, cron trigger)
//
// - Reads tracked time, screenshots and mouse/keyboard activity from D1.
// - Builds an .xlsx file (no heavy library: tiny hand-written OOXML + fflate).
// - Sends it to the admin(s) through the Resend e-mail API.
//
// Crons are declared in wrangler.jsonc ("triggers.crons"):
//   WEEKLY_CRON  "30 12 * * 5"   = every Friday 18:00 IST  -> last 7 days
//   DAILY_CRON   "30 3 * * 2-6"  = Tue-Sat 09:00 IST        -> yesterday
//                                  (only sent when REPORT_DAILY_ENABLED = "true")
//
// Settings (Worker secrets / vars, local: .dev.vars):
//   MAIL_RELAY_URL        Google Apps Script web app URL (free, no domain needed)
//   MAIL_RELAY_SECRET     shared secret checked by that script
//   RESEND_API_KEY        alternative: Resend (needs a verified domain for other recipients)
//   REPORT_EMAIL_TO       optional, comma separated. Default: all active admins
//   REPORT_EMAIL_FROM     optional. Default: WorkMonitor <onboarding@resend.dev>
//   REPORT_DAILY_ENABLED  optional, "true" to also send the daily report
//   REPORT_TRIGGER_SECRET optional, enables POST /api/admin/send-report-now
// ======================================================================

import { zipSync, strToU8 } from 'fflate';

export const WEEKLY_CRON = '30 12 * * 5';
export const DAILY_CRON = '30 3 * * 2-6';

const DAY_MS = 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------
// Dates (India time)
// ----------------------------------------------------------------------

export function istDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const part = (type) =>
    parts.find((item) => item.type === type)?.value || '';

  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return date.toISOString().slice(0, 10);
}

export function reportRange(period, now = new Date()) {
  const today = istDateKey(now);

  if (period === 'daily') {
    const yesterday = addDays(today, -1);
    return { from: yesterday, to: yesterday };
  }

  return { from: addDays(today, -6), to: today };
}

// ----------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

function toHms(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function toDecimalHours(seconds) {
  return Math.round((Math.max(0, Number(seconds) || 0) / 3600) * 100) / 100;
}

function activityPercent(active, tracked) {
  const t = Number(tracked) || 0;
  if (t <= 0) return null;
  return Math.min(100, Math.round(((Number(active) || 0) / t) * 100));
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtml(value) {
  return escapeXml(value).replace(/'/g, '&#39;');
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

// ----------------------------------------------------------------------
// Data from D1
// ----------------------------------------------------------------------

export async function loadReportData(env, from, to, options = {}) {
  const employees = options.employeeId
    ? (
        await env.DB.prepare(
          `SELECT id, name, email FROM employees WHERE approved = 1 AND id = ?`
        )
          .bind(options.employeeId)
          .all()
      ).results || []
    : (
        await env.DB.prepare(
          `SELECT id, name, email FROM employees WHERE approved = 1 ORDER BY name`
        ).all()
      ).results || [];

  const tracker =
    (
      await env.DB.prepare(
        `SELECT employee_id, date_key, total_seconds
           FROM tracker_time
          WHERE date_key >= ? AND date_key <= ?`
      )
        .bind(from, to)
        .all()
    ).results || [];

  let shots = [];
  try {
    shots =
      (
        await env.DB.prepare(
          `SELECT employee_id, date_key, COUNT(*) AS total
             FROM screenshot_index
            WHERE date_key >= ? AND date_key <= ?
            GROUP BY employee_id, date_key`
        )
          .bind(from, to)
          .all()
      ).results || [];
  } catch (error) {
    console.warn('Report: screenshot_index unavailable', error?.message);
  }

  let activity = [];
  try {
    activity =
      (
        await env.DB.prepare(
          `SELECT employee_id, date_key,
                  SUM(active_seconds)  AS active_seconds,
                  SUM(tracked_seconds) AS tracked_seconds,
                  SUM(mouse_moves)     AS mouse_moves,
                  SUM(mouse_clicks)    AS mouse_clicks,
                  SUM(key_presses)     AS key_presses
             FROM activity_snapshots
            WHERE date_key >= ? AND date_key <= ?
            GROUP BY employee_id, date_key`
        )
          .bind(from, to)
          .all()
      ).results || [];
  } catch (error) {
    // Table is created on first activity upload; no data yet is fine.
    console.warn('Report: activity_snapshots unavailable', error?.message);
  }

  const cell = new Map(); // `${employeeId}|${dateKey}` -> row

  const getCell = (employeeId, dateKey) => {
    const key = `${employeeId}|${dateKey}`;
    if (!cell.has(key)) {
      cell.set(key, {
        employeeId,
        date: dateKey,
        totalSeconds: 0,
        screenshots: 0,
        activeSeconds: 0,
        trackedSeconds: 0,
        mouseMoves: 0,
        mouseClicks: 0,
        keyPresses: 0,
      });
    }
    return cell.get(key);
  };

  tracker.forEach((r) => {
    getCell(r.employee_id, r.date_key).totalSeconds = Number(r.total_seconds || 0);
  });
  shots.forEach((r) => {
    getCell(r.employee_id, r.date_key).screenshots = Number(r.total || 0);
  });
  activity.forEach((r) => {
    const c = getCell(r.employee_id, r.date_key);
    c.activeSeconds = Number(r.active_seconds || 0);
    c.trackedSeconds = Number(r.tracked_seconds || 0);
    c.mouseMoves = Number(r.mouse_moves || 0);
    c.mouseClicks = Number(r.mouse_clicks || 0);
    c.keyPresses = Number(r.key_presses || 0);
  });

  const rows = [];
  const summary = [];

  for (const emp of employees) {
    const days = [...cell.values()]
      .filter((c) => c.employeeId === emp.id)
      .sort((a, b) => a.date.localeCompare(b.date));

    const total = days.reduce(
      (s, d) => ({
        totalSeconds: s.totalSeconds + d.totalSeconds,
        screenshots: s.screenshots + d.screenshots,
        activeSeconds: s.activeSeconds + d.activeSeconds,
        trackedSeconds: s.trackedSeconds + d.trackedSeconds,
        mouseMoves: s.mouseMoves + d.mouseMoves,
        mouseClicks: s.mouseClicks + d.mouseClicks,
        keyPresses: s.keyPresses + d.keyPresses,
      }),
      {
        totalSeconds: 0,
        screenshots: 0,
        activeSeconds: 0,
        trackedSeconds: 0,
        mouseMoves: 0,
        mouseClicks: 0,
        keyPresses: 0,
      }
    );

    const workedDays = days.filter(
      (d) => d.totalSeconds > 0 || d.screenshots > 0
    ).length;

    days
      .filter((d) => d.totalSeconds > 0 || d.screenshots > 0 || d.trackedSeconds > 0)
      .forEach((d) =>
        rows.push({ employeeName: emp.name, email: emp.email, ...d })
      );

    summary.push({
      employeeName: emp.name,
      email: emp.email,
      workedDays,
      ...total,
      activityPercent: activityPercent(total.activeSeconds, total.trackedSeconds),
    });
  }

  return { employees, rows, summary };
}

// ----------------------------------------------------------------------
// Minimal .xlsx writer
// ----------------------------------------------------------------------

const colLetter = (index) => {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

// style ids: 0 normal, 1 bold, 2 date (yyyy-mm-dd), 3 decimal 0.00
function sheetXml(header, dataRows, widths) {
  const cellXml = (value, rowIndex, colIndex, style) => {
    const ref = `${colLetter(colIndex)}${rowIndex}`;
    const s = style ? ` s="${style}"` : '';

    if (value === null || value === undefined || value === '') {
      return style ? `<c r="${ref}"${s}/>` : '';
    }

    if (value instanceof Date) {
      const serial = value.getTime() / DAY_MS + 25569; // days since 1899-12-30
      return `<c r="${ref}"${s}><v>${serial}</v></c>`;
    }

    if (typeof value === 'number') {
      return `<c r="${ref}"${s}><v>${value}</v></c>`;
    }

    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  };

  const lines = [];

  lines.push(
    `<row r="1">${header.map((h, c) => cellXml(h, 1, c, 1)).join('')}</row>`
  );

  dataRows.forEach((row, i) => {
    const r = i + 2;
    const bold = row.bold ? 1 : 0;
    lines.push(
      `<row r="${r}">${row.cells
        .map((v, c) => {
          let style = bold;
          if (!bold && v instanceof Date) style = 2;
          return cellXml(v, r, c, style);
        })
        .join('')}</row>`
    );
  });

  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${cols}</cols>` +
    `<sheetData>${lines.join('')}</sheetData></worksheet>`
  );
}

export function buildXlsx({ rows, summary, from, to }) {
  const reportHeader = [
    'Employee',
    'Email',
    'Date',
    'Total Hours (HH:MM:SS)',
    'Total Hours (Decimal)',
    'Activity %',
    'Screenshots',
    'Mouse Moves',
    'Mouse Clicks',
    'Key Presses',
  ];

  const toDate = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };

  const hasAct = (r) => (Number(r.trackedSeconds) || 0) > 0;

  const reportRows = rows.map((r) => ({
    cells: [
      r.employeeName,
      r.email,
      toDate(r.date),
      toHms(r.totalSeconds),
      toDecimalHours(r.totalSeconds),
      hasAct(r) ? activityPercent(r.activeSeconds, r.trackedSeconds) : '',
      r.screenshots,
      hasAct(r) ? r.mouseMoves : '',
      hasAct(r) ? r.mouseClicks : '',
      hasAct(r) ? r.keyPresses : '',
    ],
  }));

  const sum = rows.reduce(
    (s, r) => ({
      t: s.t + r.totalSeconds,
      shots: s.shots + r.screenshots,
      a: s.a + r.activeSeconds,
      tr: s.tr + r.trackedSeconds,
      mm: s.mm + r.mouseMoves,
      mc: s.mc + r.mouseClicks,
      kp: s.kp + r.keyPresses,
    }),
    { t: 0, shots: 0, a: 0, tr: 0, mm: 0, mc: 0, kp: 0 }
  );

  reportRows.push({
    bold: true,
    cells: [
      'TOTAL',
      '',
      '',
      toHms(sum.t),
      toDecimalHours(sum.t),
      sum.tr > 0 ? activityPercent(sum.a, sum.tr) : '',
      sum.shots,
      sum.tr > 0 ? sum.mm : '',
      sum.tr > 0 ? sum.mc : '',
      sum.tr > 0 ? sum.kp : '',
    ],
  });

  const summaryHeader = [
    'Employee',
    'Email',
    'Days Worked',
    'Total Hours (HH:MM:SS)',
    'Total Hours (Decimal)',
    'Avg Activity %',
    'Screenshots',
  ];

  const summaryRows = summary.map((s) => ({
    cells: [
      s.employeeName,
      s.email,
      s.workedDays,
      toHms(s.totalSeconds),
      toDecimalHours(s.totalSeconds),
      s.activityPercent === null ? '' : s.activityPercent,
      s.screenshots,
    ],
  }));

  const files = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `</Types>`
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>` +
        `<sheet name="Work Report" sheetId="1" r:id="rId1"/>` +
        `<sheet name="Summary" sheetId="2" r:id="rId2"/>` +
        `</sheets></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="3">` +
        `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
        `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
        `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
        `</cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
        `</styleSheet>`
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      sheetXml(reportHeader, reportRows, [24, 30, 14, 22, 20, 12, 12, 14, 14, 14])
    ),
    'xl/worksheets/sheet2.xml': strToU8(
      sheetXml(summaryHeader, summaryRows, [24, 30, 12, 22, 20, 14, 12])
    ),
  };

  return zipSync(files, { level: 6 });
}

// ----------------------------------------------------------------------
// E-mail body
// ----------------------------------------------------------------------

export function buildEmailHtml({ period, from, to, summary, scopeLabel }) {
  const title =
    period === 'daily'
      ? 'Daily work report'
      : period === 'weekly'
        ? 'Weekly work report'
        : 'Work report';
  const range = from === to ? from : `${from} to ${to}`;

  const totalSeconds = summary.reduce((s, r) => s + r.totalSeconds, 0);
  const totalShots = summary.reduce((s, r) => s + r.screenshots, 0);
  const active = summary.reduce((s, r) => s + r.activeSeconds, 0);
  const tracked = summary.reduce((s, r) => s + r.trackedSeconds, 0);
  const avg = activityPercent(active, tracked);

  const td = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;';

  const body = summary
    .map(
      (r) =>
        `<tr>` +
        `<td style="${td}"><b>${escapeHtml(r.employeeName)}</b><br><span style="color:#6b7280">${escapeHtml(r.email)}</span></td>` +
        `<td style="${td}text-align:right">${r.workedDays}</td>` +
        `<td style="${td}text-align:right">${toHms(r.totalSeconds)}</td>` +
        `<td style="${td}text-align:right">${r.activityPercent === null ? '–' : r.activityPercent + '%'}</td>` +
        `<td style="${td}text-align:right">${r.screenshots}</td>` +
        `</tr>`
    )
    .join('');

  const th =
    'padding:8px 10px;background:#f3f4f6;font-size:12px;text-align:right;color:#374151;';

  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#111827">` +
    `<h2 style="margin:0 0 4px">WorkMonitor – ${title}</h2>` +
    `<p style="margin:0 0 16px;color:#6b7280">${escapeHtml(range)} (India time)${
      scopeLabel ? ` &middot; ${escapeHtml(scopeLabel)}` : ''
    }</p>` +
    `<table style="width:100%;border-collapse:collapse;margin-bottom:16px"><tr>` +
    `<td style="padding:12px;background:#eef2ff;border-radius:8px"><div style="font-size:12px;color:#4338ca">Total time</div><div style="font-size:20px;font-weight:bold">${toHms(totalSeconds)}</div></td>` +
    `<td style="width:8px"></td>` +
    `<td style="padding:12px;background:#ecfdf5;border-radius:8px"><div style="font-size:12px;color:#047857">Average activity</div><div style="font-size:20px;font-weight:bold">${avg === null ? '–' : avg + '%'}</div></td>` +
    `<td style="width:8px"></td>` +
    `<td style="padding:12px;background:#fff7ed;border-radius:8px"><div style="font-size:12px;color:#c2410c">Screenshots</div><div style="font-size:20px;font-weight:bold">${totalShots}</div></td>` +
    `</tr></table>` +
    `<table style="width:100%;border-collapse:collapse">` +
    `<tr><th style="${th}text-align:left">Employee</th><th style="${th}">Days</th><th style="${th}">Total time</th><th style="${th}">Activity</th><th style="${th}">Screenshots</th></tr>` +
    (body ||
      `<tr><td colspan="5" style="${td}color:#6b7280">No employees found.</td></tr>`) +
    `</table>` +
    `<p style="margin-top:16px;color:#6b7280;font-size:12px">The full Excel report is attached. "–" means the desktop activity agent was not running.</p>` +
    `</div>`
  );
}


// ----------------------------------------------------------------------
// Input validation (custom date ranges)
// ----------------------------------------------------------------------

export const MAX_RANGE_DAYS = 90;

class ReportInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const isDateKey = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
};

const daysBetween = (from, to) => {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS
  );
};

function validateRange(from, to) {
  if (!isDateKey(from) || !isDateKey(to)) {
    throw new ReportInputError('Please select a valid start date and end date.');
  }

  if (from > to) {
    throw new ReportInputError('The start date must be before the end date.');
  }

  if (to > istDateKey()) {
    throw new ReportInputError('The end date cannot be in the future.');
  }

  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
    throw new ReportInputError(
      `You can select a maximum of ${MAX_RANGE_DAYS} days.`
    );
  }

  return { from, to };
}

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

// ----------------------------------------------------------------------
// Send log (table report_log) - every real send attempt is recorded so the
// Admin can see WHEN a report went out and whether it worked.
// The table is created automatically (CREATE TABLE IF NOT EXISTS).
// ----------------------------------------------------------------------

let logTableReady = false;

async function ensureLogTable(env) {
  if (logTableReady) return;

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS report_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       period TEXT NOT NULL,
       range_from TEXT,
       range_to TEXT,
       trigger_type TEXT NOT NULL,
       status TEXT NOT NULL,
       recipients TEXT,
       employees INTEGER,
       rows_count INTEGER,
       error TEXT,
       created_at TEXT NOT NULL
     )`
  ).run();

  // Columns added later (ignored when they already exist).
  for (const column of ['scope TEXT', 'requested_by TEXT']) {
    try {
      await env.DB.prepare(
        `ALTER TABLE report_log ADD COLUMN ${column}`
      ).run();
    } catch {
      // duplicate column name: already migrated
    }
  }

  logTableReady = true;
}

async function writeLog(env, entry) {
  try {
    await ensureLogTable(env);

    await env.DB.prepare(
      `INSERT INTO report_log
         (period, range_from, range_to, trigger_type, status, recipients,
          employees, rows_count, error, created_at, scope, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        entry.period || 'weekly',
        entry.from || null,
        entry.to || null,
        entry.trigger || 'auto',
        entry.status,
        (entry.recipients || []).join(', '),
        entry.employees ?? null,
        entry.rows ?? null,
        entry.error ? String(entry.error).slice(0, 500) : null,
        new Date().toISOString(),
        entry.scope || 'All employees',
        entry.requestedBy || null
      )
      .run();
  } catch (error) {
    // Logging must never break the report itself.
    console.warn('Report log write failed:', error?.message || error);
  }
}

async function readLog(env, limit = 20, requestedBy = null) {
  await ensureLogTable(env);

  const sql = `SELECT id, period, range_from, range_to, trigger_type, status,
            recipients, employees, rows_count, error, created_at, scope,
            requested_by
     FROM report_log
     ${requestedBy ? 'WHERE requested_by = ?' : ''}
     ORDER BY id DESC
     LIMIT ?`;

  const stmt = env.DB.prepare(sql);
  const res = await (requestedBy
    ? stmt.bind(requestedBy, limit)
    : stmt.bind(limit)
  ).all();

  return res.results || [];
}

// Returns an error message when the sender should wait, otherwise null.
async function manualSendLimit(env, requestedBy) {
  await ensureLogTable(env);

  const last = await env.DB.prepare(
    `SELECT created_at FROM report_log
      WHERE trigger_type = 'manual' AND requested_by = ?
      ORDER BY id DESC LIMIT 1`
  )
    .bind(requestedBy)
    .first();

  if (last?.created_at) {
    const waitMs = 60_000 - (Date.now() - new Date(last.created_at).getTime());
    if (waitMs > 0) {
      return `Please wait ${Math.ceil(waitMs / 1000)} seconds before sending again.`;
    }
  }

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM report_log
      WHERE trigger_type = 'manual' AND created_at > ?`
  )
    .bind(hourAgo)
    .first();

  if (Number(recent?.total || 0) >= 40) {
    return 'Too many reports were sent in the last hour. Please try again later.';
  }

  return null;
}

// ----------------------------------------------------------------------
// Send
// ----------------------------------------------------------------------

async function resolveRecipients(env, override) {
  const fromText = String(override || env.REPORT_EMAIL_TO || '');
  const list = fromText
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  if (list.length) return list;

  const admins =
    (
      await env.DB.prepare(`SELECT email FROM admins WHERE active = 1`).all()
    ).results || [];

  return admins.map((a) => a.email).filter(Boolean);
}

// Which e-mail service is configured:
//   MAIL_RELAY_URL  (+ MAIL_RELAY_SECRET)  Google Apps Script relay (no domain needed)
//   RESEND_API_KEY                         Resend (needs a verified domain to
//                                          send to anybody but the account owner)
// The relay is used first when both are set.
function emailConfigured(env) {
  return Boolean(env.MAIL_RELAY_URL || env.RESEND_API_KEY);
}

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function deliverEmail(env, { to, subject, html, fileName, xlsx }) {
  if (env.MAIL_RELAY_URL) {
    const response = await fetch(env.MAIL_RELAY_URL, {
      method: 'POST',
      // text/plain keeps this a "simple" request; the script reads the raw body.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        secret: env.MAIL_RELAY_SECRET || '',
        to: to.join(','),
        subject,
        html,
        fromName: env.REPORT_EMAIL_FROM_NAME || 'WorkMonitor',
        attachments: [
          { filename: fileName, mimeType: XLSX_MIME, content: toBase64(xlsx) },
        ],
      }),
      redirect: 'follow',
    });

    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON (for example a Google sign-in / error page)
    }

    if (!response.ok || !parsed?.success) {
      const reason =
        parsed?.error ||
        (text.includes('<html') ? 'Unexpected response from the mail relay (check the web app access setting).' : text);
      throw new Error(`Mail relay error ${response.status}: ${String(reason).slice(0, 300)}`);
    }

    return 'relay';
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.REPORT_EMAIL_FROM || 'WorkMonitor <onboarding@resend.dev>',
      to,
      subject,
      html,
      attachments: [{ filename: fileName, content: toBase64(xlsx) }],
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Resend error ${response.status}: ${text.slice(0, 300)}`);
  }

  return text.slice(0, 200);
}

/**
 * options:
 *   period       'weekly' | 'daily' | 'custom'  (custom needs options.range)
 *   range        { from, to }  (YYYY-MM-DD)
 *   employeeId   only this employee (default: every approved employee)
 *   to           recipient e-mail(s), comma separated (default: settings)
 *   trigger      'auto' | 'manual'
 *   requestedBy  e-mail of the person who pressed the button
 *   dryRun       build only, do not send / log
 */
export async function sendReport(env, options = {}) {
  const period =
    options.period === 'daily'
      ? 'daily'
      : options.period === 'custom'
        ? 'custom'
        : 'weekly';
  const trigger = options.trigger === 'manual' ? 'manual' : 'auto';
  const { from, to } = options.range || reportRange(period);

  const result = {
    period,
    from,
    to,
    sent: false,
  };

  let scope = 'All employees';

  try {
    const data = await loadReportData(env, from, to, {
      employeeId: options.employeeId || null,
    });

    if (options.employeeId) {
      if (!data.employees.length) {
        throw new ReportInputError('Employee not found.', 404);
      }
      scope = data.employees[0].name || data.employees[0].email;
    }

    const xlsx = buildXlsx({ ...data, from, to });

    const nameTag = options.employeeId
      ? `_${String(scope).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)}`
      : '';

    const fileName =
      from === to
        ? `work-report${nameTag}_${from}.xlsx`
        : `work-report${nameTag}_${from}_to_${to}.xlsx`;

    const html = buildEmailHtml({
      period,
      from,
      to,
      summary: data.summary,
      scopeLabel: options.employeeId ? scope : '',
    });

    const label =
      period === 'daily' ? 'daily ' : period === 'weekly' ? 'weekly ' : '';
    const subject = `WorkMonitor ${label}report${
      options.employeeId ? ` - ${scope}` : ''
    } (${from === to ? from : `${from} to ${to}`})`;

    Object.assign(result, {
      scope,
      employees: data.employees.length,
      rows: data.rows.length,
      fileName,
      subject,
      xlsx,
    });

    if (options.dryRun) return result;

    if (!emailConfigured(env)) {
      throw new Error(
        'Email service is not configured (set MAIL_RELAY_URL or RESEND_API_KEY).'
      );
    }

    const to_ = await resolveRecipients(env, options.to);

    if (!to_.length) {
      throw new Error('No recipient: set REPORT_EMAIL_TO or create an admin.');
    }

    result.recipients = to_;

    result.provider = await deliverEmail(env, {
      to: to_,
      subject,
      html,
      fileName,
      xlsx,
    });

    result.sent = true;

    await writeLog(env, {
      period,
      from,
      to,
      trigger,
      status: 'sent',
      recipients: to_,
      employees: result.employees,
      rows: result.rows,
      scope,
      requestedBy: options.requestedBy,
    });

    return result;
  } catch (error) {
    if (!options.dryRun) {
      await writeLog(env, {
        period,
        from,
        to,
        trigger,
        status: 'failed',
        recipients: result.recipients || [],
        employees: result.employees,
        rows: result.rows,
        error: error?.message || String(error),
        scope,
        requestedBy: options.requestedBy,
      });
    }

    throw error;
  }
}

// ----------------------------------------------------------------------
// Cron entry (called from export default { scheduled })
// ----------------------------------------------------------------------

export async function runScheduledReport(env, cron) {
  const period = cron === DAILY_CRON ? 'daily' : 'weekly';

  if (period === 'daily' && String(env.REPORT_DAILY_ENABLED) !== 'true') {
    console.log('Daily report skipped (REPORT_DAILY_ENABLED is not "true").');
    return;
  }

  try {
    const result = await sendReport(env, { period, trigger: 'auto' });
    console.log(
      `Report e-mail sent: ${result.period} ${result.from}..${result.to} -> ${(result.recipients || []).join(', ')}`
    );
  } catch (error) {
    // already written to report_log by sendReport()
    console.error('Scheduled report failed:', error?.message || error);
  }
}

// ----------------------------------------------------------------------
// Dashboard API
//
//   GET  /api/admin/report-log            -> history + settings (Admin)
//   POST /api/admin/send-report           -> Admin: all employees or one employee
//        { from, to, employeeId: "all" | "<id>", adminEmail }
//   GET  /api/employee/report-log?employeeId=<id>   -> own history (Employee)
//   POST /api/employee/send-report        -> Employee: own data only
//        { employeeId, from, to }
//
// Like the other /api/* endpoints of this project these are not protected by
// a token, so the e-mail address is NEVER taken from the request:
//   - Admin   : adminEmail must be an active admin in the database
//   - Employee: the address is read from the employee record
// plus a limit of 1 manual send per minute per person.
// ----------------------------------------------------------------------

function maskEmail(email) {
  const [name = '', domain = ''] = String(email).split('@');
  if (!domain) return '***';
  const head = name.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(name.length - 2, 1))}@${domain}`;
}

// Next Friday 18:00 IST (= 12:30 UTC) after "now"
function nextWeeklyRun(now = new Date()) {
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      12,
      30,
      0
    )
  );

  while (d.getUTCDay() !== 5 || d.getTime() <= now.getTime()) {
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return d.toISOString();
}

export async function handleReportLog(env, json) {
  try {
    const logs = await readLog(env, 20);
    const recipients = await resolveRecipients(env);

    return json({
      success: true,
      logs,
      settings: {
        emailConfigured: emailConfigured(env),
        recipients: recipients.map(maskEmail),
        dailyEnabled: String(env.REPORT_DAILY_ENABLED) === 'true',
        weeklySchedule: 'Every Friday 6:00 PM IST (last 7 days)',
        dailySchedule: 'Tue-Sat 9:00 AM IST (yesterday)',
        nextWeeklyRun: nextWeeklyRun(),
        maxDays: MAX_RANGE_DAYS,
      },
    });
  } catch (error) {
    return json(
      { success: false, error: error?.message || 'Failed to load report log.' },
      500
    );
  }
}

async function readBody(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

// Range from the request: custom { from, to } (validated) or legacy { period }.
function rangeFromBody(body) {
  if (body.from || body.to) {
    return validateRange(String(body.from || ''), String(body.to || ''));
  }

  return reportRange(body.period === 'daily' ? 'daily' : 'weekly');
}

async function runManualSend(env, json, { requestedBy, recipient, employeeId, range }) {
  const limit = await manualSendLimit(env, requestedBy);
  if (limit) return json({ success: false, error: limit }, 429);

  const result = await sendReport(env, {
    period: 'custom',
    range,
    employeeId,
    to: recipient,
    trigger: 'manual',
    requestedBy,
  });

  const { xlsx, ...info } = result;

  return json({
    success: true,
    ...info,
    recipients: (info.recipients || []).map(() => recipient),
  });
}

export async function handleSendReportFromAdmin(request, env, json) {
  const body = await readBody(request);

  try {
    const adminEmail = normalizeEmail(body.adminEmail);

    const admin = adminEmail
      ? await env.DB.prepare(
          `SELECT id, email FROM admins WHERE lower(email) = ? AND active = 1`
        )
          .bind(adminEmail)
          .first()
      : null;

    if (!admin) {
      throw new ReportInputError('Admin account not found.', 403);
    }

    const range = rangeFromBody(body);
    const employeeId =
      body.employeeId && body.employeeId !== 'all'
        ? String(body.employeeId)
        : null;

    return await runManualSend(env, json, {
      requestedBy: adminEmail,
      recipient: adminEmail,
      employeeId,
      range,
    });
  } catch (error) {
    return json(
      { success: false, error: error?.message || 'Report failed.' },
      error?.status || 500
    );
  }
}

export async function handleSendReportFromEmployee(request, env, json) {
  const body = await readBody(request);

  try {
    const employee = body.employeeId
      ? await env.DB.prepare(
          `SELECT id, email FROM employees WHERE id = ? AND approved = 1`
        )
          .bind(String(body.employeeId))
          .first()
      : null;

    if (!employee?.email) {
      throw new ReportInputError('Employee account not found.', 403);
    }

    const range = rangeFromBody(body);
    const email = normalizeEmail(employee.email);

    return await runManualSend(env, json, {
      requestedBy: email,
      recipient: email,
      employeeId: employee.id,
      range,
    });
  } catch (error) {
    return json(
      { success: false, error: error?.message || 'Report failed.' },
      error?.status || 500
    );
  }
}

export async function handleEmployeeReportLog(request, env, json) {
  try {
    const employeeId = new URL(request.url).searchParams.get('employeeId');

    const employee = employeeId
      ? await env.DB.prepare(
          `SELECT id, email FROM employees WHERE id = ? AND approved = 1`
        )
          .bind(String(employeeId))
          .first()
      : null;

    if (!employee?.email) {
      throw new ReportInputError('Employee account not found.', 403);
    }

    const logs = await readLog(env, 10, normalizeEmail(employee.email));

    return json({
      success: true,
      logs,
      settings: {
        emailConfigured: emailConfigured(env),
        maxDays: MAX_RANGE_DAYS,
      },
    });
  } catch (error) {
    return json(
      { success: false, error: error?.message || 'Failed to load report log.' },
      error?.status || 500
    );
  }
}

// ----------------------------------------------------------------------
// Developer trigger: POST /api/admin/send-report-now
// Header:  Authorization: Bearer <REPORT_TRIGGER_SECRET>
// Body:    { "period": "weekly" | "daily", "dryRun": true, "download": true, "to": "a@b.com" }
//   dryRun   -> build everything, do not send (and do not log)
//   download -> (with dryRun) return the .xlsx file itself
// ----------------------------------------------------------------------

export async function handleSendReportNow(request, env, json) {
  const secret = String(env.REPORT_TRIGGER_SECRET || '');

  if (!secret) {
    return json({ success: false, error: 'Manual trigger is disabled.' }, 404);
  }

  const auth = request.headers.get('Authorization') || '';

  if (auth !== `Bearer ${secret}`) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  const body = await readBody(request);

  try {
    const result = await sendReport(env, {
      period: body.period,
      dryRun: Boolean(body.dryRun),
      to: body.to,
      trigger: 'manual',
    });

    if (body.dryRun && body.download) {
      return new Response(result.xlsx, {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${result.fileName}"`,
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const { xlsx, ...info } = result;
    return json({ success: true, ...info, bytes: xlsx.length });
  } catch (error) {
    return json({ success: false, error: error?.message || 'Report failed.' }, 500);
  }
}   