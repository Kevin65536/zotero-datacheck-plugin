import type {
  AuditReport,
  DetectorFinding,
  DetectorResult,
  TableDocument,
  TableRow,
} from "./types";

type Detector = (table: TableDocument) => DetectorResult;

const DETECTORS: Detector[] = [
  detectDuplicateRows,
  detectDuplicateNumericSequences,
  detectInvalidPercentages,
  detectInvalidPValues,
];

export function buildAuditReport(table: TableDocument): AuditReport {
  const detectorResults = DETECTORS.map((detector) => detector(table));
  const findingCount = detectorResults.reduce((count, detectorResult) => {
    return count + detectorResult.findings.length;
  }, 0);
  const analyzedRowCount = getAnalyzedRows(table).length;

  return {
    createdAt: new Date().toISOString(),
    summary:
      `Parsed ${table.rowCount} rows x ${table.columnCount} columns ` +
      `(${analyzedRowCount} data rows, ${table.numericCellCount} numeric cells) ` +
      `and produced ${findingCount} finding(s).`,
    tableDiagnostics: [...table.reconstructionWarnings],
    detectorResults,
    findingCount,
  };
}

export function formatAuditReport(
  table: TableDocument,
  report: AuditReport,
): string {
  const lines = [
    "DataCheck Report",
    "",
    `Item: ${table.itemTitle}`,
    `Attachment: ${table.attachmentKey}`,
    `Page: ${table.pageNumber ?? "?"}`,
    `Captured: ${table.capturedAt}`,
    `Table shape: ${table.rowCount} row(s) x ${table.columnCount} column(s)`,
    `Numeric cells: ${table.numericCellCount}`,
    `Findings: ${report.findingCount}`,
  ];

  if (table.header?.length) {
    lines.push(`Header: ${table.header.join(" | ")}`);
  }

  if (report.tableDiagnostics.length) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of report.tableDiagnostics) {
      lines.push(`- ${diagnostic}`);
    }
  }

  lines.push("", "Detectors:");
  for (const detectorResult of report.detectorResults) {
    lines.push(
      `- ${detectorResult.detectorId}: ${detectorResult.summary}`,
    );
    for (const finding of detectorResult.findings) {
      lines.push(`  * ${finding.message}`);
    }
  }

  if (!report.findingCount) {
    lines.push("", "No findings in the current MVP detector set.");
  }

  return lines.join("\n");
}

function detectDuplicateRows(table: TableDocument): DetectorResult {
  const groupedRows = groupRowsBySignature(getAnalyzedRows(table), (row) => {
    return row.cells.map((cell) => cell.normalizedText).join("\u241f");
  });
  const findings = groupedRowsToFindings(
    groupedRows,
    "Detected rows with identical cell text.",
  );

  return {
    detectorId: "duplicate-rows",
    applicability: getAnalyzedRows(table).length >= 2 ? "applied" : "skipped",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? `Detected ${findings.length} repeated row pattern(s).`
      : "No repeated rows detected.",
    findings,
  };
}

function detectDuplicateNumericSequences(table: TableDocument): DetectorResult {
  const groupedRows = groupRowsBySignature(getAnalyzedRows(table), (row) => {
    const numericSequence = row.cells
      .filter((cell) => cell.parsedNumeric?.kind !== "p-value")
      .map((cell) => cell.parsedNumeric?.value)
      .filter((value): value is number => value !== undefined);
    if (numericSequence.length < 2) {
      return undefined;
    }
    return numericSequence.join("\u241f");
  });
  const findings = groupedRowsToFindings(
    groupedRows,
    "Detected duplicated numeric sequences across rows.",
  );

  return {
    detectorId: "duplicate-numeric-sequences",
    applicability: getAnalyzedRows(table).length >= 2 ? "applied" : "skipped",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? `Detected ${findings.length} repeated numeric sequence(s).`
      : "No repeated numeric sequences detected.",
    findings,
  };
}

function detectInvalidPercentages(table: TableDocument): DetectorResult {
  const findings: DetectorFinding[] = [];

  for (const row of table.rows) {
    for (const cell of row.cells) {
      if (cell.parsedNumeric?.kind !== "percentage") {
        continue;
      }
      if (cell.parsedNumeric.value < 0 || cell.parsedNumeric.value > 100) {
        findings.push({
          message:
            `Cell ${formatCellRef(row.index, cell.columnIndex)} has ` +
            `out-of-range percentage ${cell.rawText}.`,
          rowIndices: [row.index],
          columnIndices: [cell.columnIndex],
          cellRefs: [formatCellRef(row.index, cell.columnIndex)],
        });
      }
    }
  }

  return {
    detectorId: "invalid-percentages",
    applicability: "applied",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? `Detected ${findings.length} out-of-range percentage value(s).`
      : "No out-of-range percentage values detected.",
    findings,
  };
}

function detectInvalidPValues(table: TableDocument): DetectorResult {
  const findings: DetectorFinding[] = [];

  for (const row of table.rows) {
    for (const cell of row.cells) {
      if (cell.parsedNumeric?.kind !== "p-value") {
        continue;
      }
      if (cell.parsedNumeric.value < 0 || cell.parsedNumeric.value > 1) {
        findings.push({
          message:
            `Cell ${formatCellRef(row.index, cell.columnIndex)} has ` +
            `out-of-range p-value ${cell.rawText}.`,
          rowIndices: [row.index],
          columnIndices: [cell.columnIndex],
          cellRefs: [formatCellRef(row.index, cell.columnIndex)],
        });
      }
    }
  }

  return {
    detectorId: "invalid-p-values",
    applicability: "applied",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? `Detected ${findings.length} out-of-range p-value(s).`
      : "No out-of-range p-values detected.",
    findings,
  };
}

function getAnalyzedRows(table: TableDocument): TableRow[] {
  return table.rows.filter((row) => row.index !== table.headerRowIndex);
}

function groupRowsBySignature(
  rows: TableRow[],
  getSignature: (row: TableRow) => string | undefined,
): Map<string, TableRow[]> {
  const groupedRows = new Map<string, TableRow[]>();

  for (const row of rows) {
    const signature = getSignature(row);
    if (!signature || signature.length === 0) {
      continue;
    }

    const entries = groupedRows.get(signature) ?? [];
    entries.push(row);
    groupedRows.set(signature, entries);
  }

  return groupedRows;
}

function groupedRowsToFindings(
  groupedRows: Map<string, TableRow[]>,
  prefix: string,
): DetectorFinding[] {
  const findings: DetectorFinding[] = [];

  for (const [signature, rows] of groupedRows.entries()) {
    if (rows.length < 2) {
      continue;
    }
    findings.push({
      message:
        `${prefix} Rows ${rows.map((row) => row.index + 1).join(", ")} share ` +
        `the signature ${signature.replace(/\u241f/g, " | ")}.`,
      rowIndices: rows.map((row) => row.index),
      evidence: [signature.replace(/\u241f/g, " | ")],
    });
  }

  return findings;
}

function formatCellRef(rowIndex: number, columnIndex: number): string {
  return `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
}