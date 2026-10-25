export interface CsvRecord { cells: string[]; lineNumber: number; raw: string }

export class CsvSyntaxError extends Error {
  constructor(readonly lineNumber: number) {
    super("invalid CSV quoting");
  }
}

export function csvRecords(csv: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [], cell = "";
  let state: "start" | "unquoted" | "quoted" | "closed" = "start";
  let lineNumber = 1, startLine = 1, start = 0;
  for (let i = 0; i <= csv.length; i++) {
    const ch = csv[i];
    if (state === "quoted") {
      if (ch === undefined) throw new CsvSyntaxError(startLine);
      if (ch === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i++; }
        else state = "closed";
      } else {
        cell += ch;
        if (ch === "\n" || (ch === "\r" && csv[i + 1] !== "\n")) lineNumber++;
      }
    } else if (ch === undefined || ch === "\r" || ch === "\n") {
      const raw = csv.slice(start, i);
      if (raw !== "") records.push({ cells: [...cells, cell], lineNumber: startLine, raw });
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      lineNumber++;
      startLine = lineNumber;
      start = i + 1;
      cells = []; cell = ""; state = "start";
    } else if (ch === ",") {
      cells.push(cell); cell = ""; state = "start";
    } else if (ch === '"' && state === "start") {
      state = "quoted";
    } else {
      if (ch === '"' || state === "closed") throw new CsvSyntaxError(startLine);
      cell += ch;
      state = "unquoted";
    }
  }
  return records;
}
