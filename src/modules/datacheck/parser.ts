import type {
  ParsedNumericValue,
  TableCell,
  TableDocument,
  TableRow,
  TableSelectionDraft,
} from "./types";

interface DelimiterCandidate {
  name: string;
  split: (line: string) => string[];
}

const DELIMITER_CANDIDATES: DelimiterCandidate[] = [
  {
    name: "tab",
    split: (line) => line.split(/\t+/),
  },
  {
    name: "pipe",
    split: (line) => line.split("|"),
  },
  {
    name: "semicolon",
    split: (line) => line.split(/\s*;\s*/),
  },
  {
    name: "multi-space",
    split: (line) => line.split(/\s{2,}/),
  },
];

export function parseTableSelection(
  draft: TableSelectionDraft,
): TableDocument {
  const structuredRows = normalizeStructuredRows(draft.structuredRows);
  if (structuredRows.length) {
    const rawText = structuredRows.map((row) => row.join("\t")).join("\n");
    const reconstructionWarnings = [...(draft.extractionDiagnostics ?? [])];
    return buildTableDocumentFromRows(
      draft,
      rawText,
      structuredRows,
      reconstructionWarnings,
    );
  }

  const rawText = draft.selectedText.replace(/\r\n?/g, "\n");
  const lines = rawText
    .split("\n")
    .map((line) => line.replace(/\u00a0/g, " ").trim())
    .filter(Boolean);
  const reconstructionWarnings: string[] = [...(draft.extractionDiagnostics ?? [])];

  if (lines.length < 2) {
    reconstructionWarnings.push(
      "Selection contains fewer than two non-empty lines.",
    );
  }

  const delimiter = chooseDelimiter(lines);
  if (!delimiter) {
    reconstructionWarnings.push(
      "Could not infer a stable multi-column delimiter from the selected text.",
    );
  }

  const rawRows = lines.map((line) => splitLine(line, delimiter));
  const columnCount = Math.max(1, ...rawRows.map((row) => row.length));

  if (columnCount < 2) {
    reconstructionWarnings.push(
      "Parsed selection only contains a single column after normalization.",
    );
  }

  const paddedRows = rawRows.map((row) => {
    const nextRow = [...row];
    while (nextRow.length < columnCount) {
      nextRow.push("");
    }
    return nextRow;
  });

  if (paddedRows.some((row) => row.some((cell) => cell.length === 0))) {
    reconstructionWarnings.push(
      "Some rows have missing cells after column alignment.",
    );
  }

  return buildTableDocumentFromRows(
    draft,
    rawText,
    paddedRows,
    reconstructionWarnings,
  );
}

function buildTableDocumentFromRows(
  draft: TableSelectionDraft,
  rawText: string,
  paddedRows: string[][],
  reconstructionWarnings: string[],
): TableDocument {
  const columnCount = Math.max(1, ...paddedRows.map((row) => row.length));

  const normalizedRows = paddedRows.map((row) => {
    const nextRow = [...row];
    while (nextRow.length < columnCount) {
      nextRow.push("");
    }
    return nextRow;
  });

  const headerRowIndex = inferHeaderRowIndex(normalizedRows);
  const header =
    headerRowIndex === undefined ? undefined : [...normalizedRows[headerRowIndex]];

  const rows = normalizedRows.map<TableRow>((row, rowIndex) => ({
    index: rowIndex,
    cells: row.map<TableCell>((rawCell, columnIndex) => {
      const normalizedText = normalizeCellText(rawCell);
      return {
        rawText: rawCell,
        normalizedText,
        rowIndex,
        columnIndex,
        parsedNumeric: parseNumericValue(normalizedText),
      };
    }),
  }));

  const numericCellCount = rows.flatMap((row) => row.cells).filter((cell) => {
    return cell.parsedNumeric !== undefined;
  }).length;

  return {
    source: draft.source,
    attachmentID: draft.attachmentID,
    attachmentKey: draft.attachmentKey,
    itemTitle: draft.itemTitle,
    pageNumber: draft.pageNumber,
    capturedAt: draft.capturedAt,
    rawText,
    selectionRectCount: draft.selectionRectCount,
    header,
    headerRowIndex,
    rows,
    rowCount: rows.length,
    columnCount,
    numericCellCount,
    reconstructionWarnings,
  };
}

function normalizeStructuredRows(rows: string[][] | undefined): string[][] {
  if (!rows?.length) {
    return [];
  }

  return rows
    .map((row) => row.map((cell) => normalizeCellText(cell)))
    .filter((row) => row.some((cell) => cell.length > 0));
}

export function parseNumericValue(
  rawText: string,
): ParsedNumericValue | undefined {
  const normalized = rawText
    .trim()
    .replace(/[−–]/g, "-")
    .replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }

  const pValueMatch = normalized.match(
    /^p\s*(<=|>=|=|<|>)?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)$/i,
  );
  if (pValueMatch) {
    const value = Number(pValueMatch[2]);
    if (!Number.isFinite(value)) {
      return undefined;
    }
    const comparator = pValueMatch[1] as ParsedNumericValue["comparator"];
    return {
      value,
      kind: "p-value",
      comparator,
      normalizedText: comparator ? `p ${comparator} ${value}` : `p ${value}`,
    };
  }

  const comparatorMatch = normalized.match(/^(<=|>=|=|<|>)\s*(.+)$/);
  const comparator = comparatorMatch?.[1] as ParsedNumericValue["comparator"];
  let valueText = comparatorMatch?.[2] ?? normalized;
  let kind: ParsedNumericValue["kind"] = "number";

  if (valueText.endsWith("%")) {
    kind = "percentage";
    valueText = valueText.slice(0, -1).trim();
  }

  valueText = valueText.replace(/,/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(valueText)) {
    return undefined;
  }

  const value = Number(valueText);
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return {
    value,
    kind,
    comparator,
    normalizedText: kind === "percentage" ? `${value}%` : String(value),
  };
}

function chooseDelimiter(lines: string[]): DelimiterCandidate | undefined {
  if (lines.length === 0) {
    return undefined;
  }

  for (const candidate of DELIMITER_CANDIDATES) {
    const parsedRows = lines.map((line) => splitLine(line, candidate));
    const multiColumnRows = parsedRows.filter((row) => row.length >= 2).length;
    if (multiColumnRows >= Math.max(2, Math.ceil(lines.length / 2))) {
      return candidate;
    }
  }

  return undefined;
}

function splitLine(
  line: string,
  delimiter: DelimiterCandidate | undefined,
): string[] {
  if (!delimiter) {
    return [normalizeCellText(line)];
  }

  return delimiter
    .split(line)
    .map((cell) => normalizeCellText(cell))
    .filter((cell, index, row) => {
      return !(cell === "" && row.length > 1 && index === row.length - 1);
    });
}

function inferHeaderRowIndex(rows: string[][]): number | undefined {
  if (rows.length < 2) {
    return undefined;
  }

  const [firstRow, secondRow] = rows;
  const firstNumericCount = firstRow.filter((cell) => parseNumericValue(cell)).length;
  const secondNumericCount = secondRow.filter((cell) => parseNumericValue(cell)).length;
  const firstHasLabels = firstRow.some((cell) => /[A-Za-z\u4e00-\u9fff]/.test(cell));

  if (firstHasLabels && secondNumericCount >= firstNumericCount) {
    return 0;
  }

  return undefined;
}

function normalizeCellText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}