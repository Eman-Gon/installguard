import { parse } from 'csv-parse/sync';
export function importCsv(text) {
  const rows = parse(text, { columns: true, skip_empty_lines: true });
  for (const row of rows) {
    if (!row.name?.trim() || !row.email?.trim()) throw new Error('name and email are required');
  }
  return rows;
}
