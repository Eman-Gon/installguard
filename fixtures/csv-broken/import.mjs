import { parse } from 'csv-parse/sync';
export function importCsv(text) {
  return parse(text, { columns: true, skip_empty_lines: true });
}
