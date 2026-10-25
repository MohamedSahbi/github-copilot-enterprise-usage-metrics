// Splits a T-SQL script into batches on `GO` lines, the way sqlcmd does, so migrations can be sent over a plain connection.
// A line counts as GO only when it starts outside a string, quoted identifier or block comment.

const GO_LINE = /^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i;

type State = { block: number; quote: "" | "'" | '"' | "]" };

function advance(line: string, state: State): void {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (state.block > 0) {
      if (c === "*" && next === "/") { state.block--; i++; }
      else if (c === "/" && next === "*") { state.block++; i++; }
    } else if (state.quote) {
      if (c === state.quote) {
        if (next === state.quote) i++;
        else state.quote = "";
      }
    } else if (c === "-" && next === "-") {
      return;
    } else if (c === "/" && next === "*") {
      state.block++; i++;
    } else if (c === "'" || c === '"') {
      state.quote = c;
    } else if (c === "[") {
      state.quote = "]";
    }
  }
}

export function splitBatches(sql: string): string[] {
  const batches: string[] = [];
  const state: State = { block: 0, quote: "" };
  let current: string[] = [];

  const flush = (repeat: number): void => {
    const text = current.join("\n").trim();
    current = [];
    if (text) for (let i = 0; i < repeat; i++) batches.push(text);
  };

  for (const line of sql.split(/\r?\n/)) {
    const go = state.block === 0 && !state.quote ? GO_LINE.exec(line) : null;
    if (go) {
      flush(go[1] ? Number(go[1]) : 1);
    } else {
      current.push(line);
      advance(line, state);
    }
  }
  flush(1);
  return batches;
}
