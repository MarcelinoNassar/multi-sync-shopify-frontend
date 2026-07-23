export function normalizeDiagnosticsSearch(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}
