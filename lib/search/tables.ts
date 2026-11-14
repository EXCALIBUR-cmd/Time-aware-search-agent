export type FlattenedPage = { text: string; rows: string[] };

const MARKDOWN_SEPARATOR = /^\|?\s*:?-{3,}/;
const HTML_TABLE = /<table[\s\S]*?<\/table>/gi;
const HTML_ROW = /<tr[\s\S]*?<\/tr>/gi;
const HTML_CELL = /<t([hd])[^>]*>([\s\S]*?)<\/t[hd]>/gi;

const cleanCell = (cell: string) =>
  cell
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const markdownCells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cleanCell);

function rowLine(headers: string[], cells: string[]): string {
  return cells
    .map((cell, i) => (i === 0 || !headers[i] || !cell ? cell : `${headers[i]}: ${cell}`))
    .filter(Boolean)
    .join(' | ');
}

function flattenHtmlTables(text: string, rows: string[]): string {
  return text.replace(HTML_TABLE, (table) => {
    const parsed = (table.match(HTML_ROW) ?? []).map((row) => [...row.matchAll(HTML_CELL)].map((cell) => ({ isHeader: cell[1] === 'h', text: cleanCell(cell[2]) })));
    const headerRow = parsed.find((cells) => cells.length && cells.every((cell) => cell.isHeader));
    const headers = headerRow?.map((cell) => cell.text) ?? [];
    const lines = parsed.filter((cells) => cells !== headerRow && cells.length).map((cells) => rowLine(headers, cells.map((cell) => cell.text)));
    rows.push(...lines);
    return `\n${lines.join('\n')}\n`;
  });
}

function flattenMarkdownTables(text: string, rows: string[]): string {
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const startsTable = lines[i].trim().startsWith('|') && MARKDOWN_SEPARATOR.test(lines[i + 1]?.trim() ?? '');
    if (!startsTable) {
      out.push(lines[i]);
      continue;
    }
    const headers = markdownCells(lines[i]);
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const line = rowLine(headers, markdownCells(lines[j]));
      rows.push(line);
      out.push(line);
    }
    i = j - 1;
  }
  return out.join('\n');
}

export function flattenTables(page: string): FlattenedPage {
  const rows: string[] = [];
  const text = flattenMarkdownTables(flattenHtmlTables(page, rows), rows);
  return { text, rows };
}
