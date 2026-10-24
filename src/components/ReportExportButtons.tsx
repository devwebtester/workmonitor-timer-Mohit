import React, { useState } from 'react';
import { Download } from 'lucide-react';
import {
  ReportRow,
  exportCsv,
  exportExcel,
  filterByRange,
} from '../lib/exportService';

interface Props {
  rows?: ReportRow[]; // ready data (Employee dashboard)
  loadRows?: () => Promise<ReportRow[]>; // fetch on click (Admin dashboard)
  fileName: string; // without extension
}

// Date-range picker + "Download CSV" / "Download Excel" buttons.
export const ReportExportButtons: React.FC<Props> = ({ rows = [], loadRows, fileName }) => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const name = `${fileName}${from || to ? `_${from || 'start'}_to_${to || 'today'}` : ''}`;

  const run = async (kind: 'csv' | 'xlsx') => {
    setError('');
    try {
      setBusy(true);
      const source = loadRows ? await loadRows() : rows;
      const filtered = filterByRange(source, from, to);
      if (!filtered.length) {
        setError('No data for the selected range.');
        return;
      }
      if (kind === 'csv') exportCsv(filtered, name);
      else await exportExcel(filtered, name);
    } catch (e) {
      console.error(e);
      setError('Export failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const input =
    'border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg px-2 py-1.5 text-xs';
  const btn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50';

  return (
    <div className="flex flex-wrap items-end gap-3 p-3 border border-slate-200 dark:border-slate-800 rounded-xl">
      <label className="text-[11px] font-bold uppercase text-slate-500">
        From
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={`${input} block mt-1`} />
      </label>
      <label className="text-[11px] font-bold uppercase text-slate-500">
        To
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={`${input} block mt-1`} />
      </label>
      <button type="button" disabled={busy} onClick={() => run('csv')} className={btn}>
        <Download className="w-3.5 h-3.5" /> CSV
      </button>
      <button type="button" disabled={busy} onClick={() => run('xlsx')} className={btn}>
        <Download className="w-3.5 h-3.5" /> Excel
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
};
