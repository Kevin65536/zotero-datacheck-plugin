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
  detectRepeatedNumericColumns,
  detectUniformNumericColumns,
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

function detectRepeatedNumericColumns(table: TableDocument): DetectorResult {
  const analyzedRows = getAnalyzedRows(table);
  const groupedColumns = new Map<string, number[]>();
  const findings: DetectorFinding[] = [];

  for (let columnIndex = 0; columnIndex < table.columnCount; columnIndex += 1) {
    const numericCells = analyzedRows
      .map((row) => row.cells[columnIndex])
      .filter((cell) => cell?.parsedNumeric);
    if (numericCells.length < 3 || numericCells.length !== analyzedRows.length) {
      continue;
    }

    const signature = numericCells
      .map((cell) => cell.parsedNumeric?.normalizedText ?? "")
      .join("\u241f");
    const columns = groupedColumns.get(signature) ?? [];
    columns.push(columnIndex);
    groupedColumns.set(signature, columns);
  }

  for (const [signature, columnIndices] of groupedColumns.entries()) {
    if (columnIndices.length < 2) {
      continue;
    }

    findings.push({
      message:
        `Columns ${columnIndices.map((columnIndex) => formatColumnLabel(table, columnIndex)).join(", ")} ` +
        `share the same numeric series across ${analyzedRows.length} data row(s): ` +
        `${signature.replace(/\u241f/g, " | ")}.`,
      columnIndices,
      evidence: [signature.replace(/\u241f/g, " | ")],
    });
  }

  return {
    detectorId: "repeated-numeric-columns",
    applicability: analyzedRows.length >= 3 ? "applied" : "skipped",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? `Detected ${findings.length} repeated numeric column pattern(s).`
      : "No repeated numeric columns detected.",
    findings,
  };
}

function detectUniformNumericColumns(table: TableDocument): DetectorResult {
  const analyzedRows = getAnalyzedRows(table);
  const findings: DetectorFinding[] = [];

  for (let columnIndex = 0; columnIndex < table.columnCount; columnIndex += 1) {
    const numericCells = analyzedRows
      .map((row) => row.cells[columnIndex])
      .filter((cell) => cell?.parsedNumeric);
    if (numericCells.length < 3) {
      continue;
    }

    const groupedValues = new Map<string, number>();
    for (const cell of numericCells) {
      const key = cell.parsedNumeric?.normalizedText ?? cell.normalizedText;
      groupedValues.set(key, (groupedValues.get(key) ?? 0) + 1);
    }

    let dominantValue = "";
    let dominantCount = 0;
    for (const [value, count] of groupedValues.entries()) {
      if (count > dominantCount) {
        dominantValue = value;
        dominantCount = count;
      }
    }

    if (dominantCount < Math.max(3, Math.ceil(numericCells.length * 0.8))) {
      continue;
    }

    findings.push({
      message:
        `Column ${formatColumnLabel(table, columnIndex)} repeats ${dominantValue} ` +
        `in ${dominantCount}/${numericCells.length} numeric cell(s).`,
      columnIndices: [columnIndex],
      evidence: [dominantValue],
    });
  }

  return {
    detectorId: "uniform-numeric-columns",
    applicability: analyzedRows.length >= 3 ? "applied" : "skipped",
    severity: "info",
    summary: findings.length
      ? `Flagged ${findings.length} numeric column(s) with dominant repeated values.`
      : "No dominant repeated numeric columns detected.",
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

function formatColumnLabel(table: TableDocument, columnIndex: number): string {
  const columnRef = String.fromCharCode(65 + columnIndex);
  const headerText = table.header?.[columnIndex]?.trim();
  return headerText ? `${headerText} (${columnRef})` : columnRef;
}