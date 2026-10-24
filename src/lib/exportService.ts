// Report export (CSV / Excel) for the Time & Activity report.
// Pure client-side: builds files from data the report already has.

export interface ReportRow {
  employeeName: string;
  email: string;
  date: string; // YYYY-MM-DD
  totalSeconds: number;
  screenshots: number;
  // Mouse / keyboard activity (from the desktop agent). All optional: days
  // without agent data simply have no activity numbers.
  activeSeconds?: number;
  trackedSeconds?: number;
  mouseMoves?: number;
  mouseClicks?: number;
  keyPresses?: number;
}

const HEADERS = [
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

const COLUMN_WIDTHS = [24, 30, 14, 22, 20, 12, 12, 14, 14, 14];

const DATE_COLUMN = 2;

const pad = (n: number) => String(n).padStart(2, '0');

export const toHms = (seconds: number): string => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

export const toDecimalHours = (seconds: number): number =>
  Math.round(((Math.max(0, Number(seconds) || 0)) / 3600) * 100) / 100;

/** Activity % = active seconds / tracked seconds. null when there is no agent data. */
export const activityPercent = (active?: number, tracked?: number): number | null => {
  const t = Number(tracked) || 0;
  if (t <= 0) return null;
  return Math.min(100, Math.round(((Number(active) || 0) / t) * 100));
};

const hasActivity = (r: ReportRow) => (Number(r.trackedSeconds) || 0) > 0;

const rowToCells = (r: ReportRow): (string | number)[] => [
  r.employeeName,
  r.email,
  r.date,
  toHms(r.totalSeconds),
  toDecimalHours(r.totalSeconds),
  hasActivity(r) ? (activityPercent(r.activeSeconds, r.trackedSeconds) as number) : '',
  r.screenshots,
  hasActivity(r) ? Number(r.mouseMoves) || 0 : '',
  hasActivity(r) ? Number(r.mouseClicks) || 0 : '',
  hasActivity(r) ? Number(r.keyPresses) || 0 : '',
];

const escapeCsv = (v: string | number): string => {
  let s = String(v ?? '');
  // Prevent spreadsheet formula injection from user-controlled text.
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Quote a value for CSV without touching its content.
const csvQuote = (s: string): string =>
  /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

const saveBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const exportCsv = (rows: ReportRow[], fileName: string) => {
  const lines = [
    HEADERS.map(escapeCsv).join(','),
    ...rows.map((r) =>
      rowToCells(r)
        .map((cell, i) =>
          // Date as ="2026-10-22": Excel keeps it as plain text, so it is never
          // shown as ######## and never reformatted by the computer's region.
          i === DATE_COLUMN ? csvQuote(`="${cell}"`) : escapeCsv(cell)
        )
        .join(',')
    ),
  ].join('\r\n');
  // BOM so Excel opens UTF-8 (Gujarati/Hindi names) correctly.
  saveBlob(new Blob(['﻿' + lines], { type: 'text/csv;charset=utf-8' }), `${fileName}.csv`);
};

export const exportExcel = async (rows: ReportRow[], fileName: string) => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Work Report');
  ws.columns = HEADERS.map((h, i) => ({ header: h, width: COLUMN_WIDTHS[i] }));
  rows.forEach((r) => {
    const cells: (string | number | Date)[] = rowToCells(r);
    const [y, m, d] = r.date.split('-').map(Number);
    // Real Excel date (UTC midnight so the day never shifts), shown as yyyy-mm-dd.
    if (y && m && d) cells[DATE_COLUMN] = new Date(Date.UTC(y, m - 1, d));
    ws.addRow(cells);
  });
  ws.getColumn(DATE_COLUMN + 1).numFmt = 'yyyy-mm-dd';
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const total = rows.reduce((s, r) => s + r.totalSeconds, 0);
  const shots = rows.reduce((s, r) => s + r.screenshots, 0);
  // Weighted: total active seconds / total tracked seconds (not an average of percentages).
  const active = rows.reduce((s, r) => s + (Number(r.activeSeconds) || 0), 0);
  const tracked = rows.reduce((s, r) => s + (Number(r.trackedSeconds) || 0), 0);
  const totalActivity = activityPercent(active, tracked);
  const sum = (key: 'mouseMoves' | 'mouseClicks' | 'keyPresses') =>
    tracked > 0 ? rows.reduce((s, r) => s + (Number(r[key]) || 0), 0) : '';

  const t = ws.addRow([
    'TOTAL',
    '',
    '',
    toHms(total),
    toDecimalHours(total),
    totalActivity === null ? '' : totalActivity,
    shots,
    sum('mouseMoves'),
    sum('mouseClicks'),
    sum('keyPresses'),
  ]);
  t.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  saveBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${fileName}.xlsx`
  );
};
