// Report export (CSV / Excel) for Employee and Admin dashboards.
// Pure client-side: builds files from data the dashboards already have.

export interface ReportRow {
  employeeName: string;
  email: string;
  date: string; // YYYY-MM-DD
  totalSeconds: number;
  screenshots: number;
}

const HEADERS = [
  'Employee',
  'Email',
  'Date',
  'Total Hours (HH:MM:SS)',
  'Total Hours (Decimal)',
  'Screenshots',
];

const pad = (n: number) => String(n).padStart(2, '0');

export const toHms = (seconds: number): string => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

export const toDecimalHours = (seconds: number): number =>
  Math.round(((Math.max(0, Number(seconds) || 0)) / 3600) * 100) / 100;

const rowToCells = (r: ReportRow) => [
  r.employeeName,
  r.email,
  r.date,
  toHms(r.totalSeconds),
  toDecimalHours(r.totalSeconds),
  r.screenshots,
];

// Filter by optional inclusive date range (YYYY-MM-DD strings compare correctly).
export const filterByRange = (rows: ReportRow[], from?: string, to?: string) =>
  rows
    .filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName));

const escapeCsv = (v: string | number): string => {
  let s = String(v ?? '');
  // Prevent spreadsheet formula injection from user-controlled text.
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

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
  const lines = [HEADERS, ...rows.map(rowToCells)]
    .map((cells) => cells.map(escapeCsv).join(','))
    .join('\r\n');
  // BOM so Excel opens UTF-8 (Gujarati/Hindi names) correctly.
  saveBlob(new Blob(['﻿' + lines], { type: 'text/csv;charset=utf-8' }), `${fileName}.csv`);
};

export const exportExcel = async (rows: ReportRow[], fileName: string) => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Work Report');
  ws.columns = HEADERS.map((h, i) => ({ header: h, width: [24, 30, 14, 22, 20, 12][i] }));
  rows.forEach((r) => ws.addRow(rowToCells(r)));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const total = rows.reduce((s, r) => s + r.totalSeconds, 0);
  const shots = rows.reduce((s, r) => s + r.screenshots, 0);
  const t = ws.addRow(['TOTAL', '', '', toHms(total), toDecimalHours(total), shots]);
  t.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  saveBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${fileName}.xlsx`
  );
};
