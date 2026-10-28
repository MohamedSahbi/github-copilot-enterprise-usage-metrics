export function requireSqlResultSet<T>(rows: readonly T[] | undefined, operation: string): readonly T[] {
  if (!rows) throw new Error(`${operation} query returned no result set`);
  return rows;
}

export function requireFirstSqlRow<T>(rows: readonly T[] | undefined, operation: string): T {
  const row = rows?.[0];
  if (!row) throw new Error(`${operation} query returned no result row`);
  return row;
}
