/**
 * A destination pattern as the gate matches it: trimmed, NFKC, lower case.
 * One function for the loader, lint and the gate, so a pattern that one of
 * them reads as harmless cannot mean everything to another: a fullwidth
 * asterisk is a bare one after NFKC (Codex).
 */
export function destinationPattern(entry: string): string {
  return entry.trim().normalize('NFKC').toLowerCase()
}
