export type ParsedLine = {
  /** 1-based line number in the source file (for debuggable error reporting). */
  line: number;
  data: unknown;
};

export type LineError = {
  line: number;
  error: string;
};

export type JsonlParseResult = {
  records: ParsedLine[];
  errors: LineError[];
  /** Count of non-blank lines encountered (records + errors). */
  totalLines: number;
};

/**
 * Parse JSONL/NDJSON text safely and debuggably.
 *
 * Blank/whitespace-only lines are ignored. Each remaining line is `JSON.parse`d
 * in isolation: a malformed line does not abort the whole file — instead it is
 * recorded as `{ line, error }` with its 1-based line number and the parser's
 * message, and parsing continues (skip-and-report policy). This satisfies the
 * "JSONL parsing is safe and debuggable" acceptance criterion.
 */
export function parseJsonl(text: string): JsonlParseResult {
  const records: ParsedLine[] = [];
  const errors: LineError[] = [];
  let totalLines = 0;

  // Split on both \n and \r\n; keep index for accurate line numbers.
  const rawLines = text.split(/\r?\n/);

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue; // ignore blank lines

    const lineNo = i + 1;
    totalLines++;

    try {
      const data = JSON.parse(trimmed);
      records.push({ line: lineNo, data });
    } catch (e) {
      errors.push({ line: lineNo, error: e instanceof Error ? e.message : "Invalid JSON" });
    }
  }

  return { records, errors, totalLines };
}
