import type {
  AuditReport,
  DetectorFinding,
  DetectorResult,
  TableDocument,
  TableRow,
} from "./types";
import { getString } from "../../utils/locale";

export interface BenfordDigitBin {
  digit: number;
  observedCount: number;
  observedRatio: number;
  expectedRatio: number;
  absoluteDeviation: number;
}

export interface BenfordProfile {
  sampleCount: number;
  mad: number;
  bins: BenfordDigitBin[];
}

type Detector = (table: TableDocument) => DetectorResult;

const BENFORD_EXPECTED_RATIOS = [
  0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046,
];
const BENFORD_MIN_SAMPLE_COUNT = 20;
const BENFORD_WARNING_MAD_THRESHOLD = 0.015;

const DETECTORS: Detector[] = [
  detectDuplicateRows,
  detectDuplicateNumericSequences,
  detectBenfordDeviation,
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
    summary: getString("audit-summary", {
      args: {
        rows: table.rowCount,
        cols: table.columnCount,
        dataRows: analyzedRowCount,
        numericCells: table.numericCellCount,
        findings: findingCount,
      },
    }),
    tableDiagnostics: [...table.reconstructionWarnings],
    detectorResults,
    findingCount,
  };
}

export function buildBenfordProfile(table: TableDocument): BenfordProfile {
  const firstDigitCounts = Array.from({ length: 9 }, () => 0);

  for (const row of getAnalyzedRows(table)) {
    for (const cell of row.cells) {
      if (cell.parsedNumeric?.kind !== "number") {
        continue;
      }

      const leadingDigit = getLeadingDigit(cell.parsedNumeric.value);
      if (!leadingDigit) {
        continue;
      }

      firstDigitCounts[leadingDigit - 1] += 1;
    }
  }

  const sampleCount = firstDigitCounts.reduce(
    (count, value) => count + value,
    0,
  );
  const bins = BENFORD_EXPECTED_RATIOS.map((expectedRatio, index) => {
    const observedCount = firstDigitCounts[index];
    const observedRatio = sampleCount ? observedCount / sampleCount : 0;
    return {
      digit: index + 1,
      observedCount,
      observedRatio,
      expectedRatio,
      absoluteDeviation: Math.abs(observedRatio - expectedRatio),
    };
  });

  return {
    sampleCount,
    mad: sampleCount
      ? bins.reduce((sum, bin) => sum + bin.absoluteDeviation, 0) / bins.length
      : 0,
    bins,
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
    lines.push(`- ${detectorResult.detectorId}: ${detectorResult.summary}`);
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
  const findings = groupedRowsToFindings(groupedRows, (rows, signature) => ({
    message: getString("audit-detector-duplicate-rows-finding", {
      args: {
        rows: rows.map((row) => row.index + 1).join(", "),
        signature,
      },
    }),
    rowIndices: rows.map((row) => row.index),
    evidence: [signature],
  }));

  return {
    detectorId: "duplicate-rows",
    applicability: getAnalyzedRows(table).length >= 2 ? "applied" : "skipped",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? getString("audit-detector-duplicate-rows-summary-hit", {
          args: { count: findings.length },
        })
      : getString("audit-detector-duplicate-rows-summary-clear"),
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
  const findings = groupedRowsToFindings(groupedRows, (rows, signature) => ({
    message: getString("audit-detector-duplicate-numeric-finding", {
      args: {
        rows: rows.map((row) => row.index + 1).join(", "),
        signature,
      },
    }),
    rowIndices: rows.map((row) => row.index),
    evidence: [signature],
  }));

  return {
    detectorId: "duplicate-numeric-sequences",
    applicability: getAnalyzedRows(table).length >= 2 ? "applied" : "skipped",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? getString("audit-detector-duplicate-numeric-summary-hit", {
          args: { count: findings.length },
        })
      : getString("audit-detector-duplicate-numeric-summary-clear"),
    findings,
  };
}

function detectBenfordDeviation(table: TableDocument): DetectorResult {
  const profile = buildBenfordProfile(table);
  if (profile.sampleCount < BENFORD_MIN_SAMPLE_COUNT) {
    return {
      detectorId: "benford-deviation",
      applicability: "skipped",
      severity: "info",
      summary: getString("audit-detector-benford-summary-skip", {
        args: {
          count: profile.sampleCount,
          minimum: BENFORD_MIN_SAMPLE_COUNT,
        },
      }),
      findings: [],
    };
  }

  const dominantDigits = [...profile.bins]
    .sort((left, right) => right.absoluteDeviation - left.absoluteDeviation)
    .slice(0, 3)
    .map((bin) => {
      return getString("audit-detector-benford-digit-detail", {
        args: {
          digit: bin.digit,
          observed: formatRatio(bin.observedRatio),
          expected: formatRatio(bin.expectedRatio),
        },
      });
    })
    .join("; ");

  const findings: DetectorFinding[] =
    profile.mad >= BENFORD_WARNING_MAD_THRESHOLD
      ? [
          {
            message: getString("audit-detector-benford-finding", {
              args: {
                digits: dominantDigits,
                mad: formatMad(profile.mad),
                count: profile.sampleCount,
              },
            }),
            evidence: dominantDigits ? [dominantDigits] : undefined,
          },
        ]
      : [];

  return {
    detectorId: "benford-deviation",
    applicability: "applied",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? getString("audit-detector-benford-summary-hit", {
          args: {
            mad: formatMad(profile.mad),
            count: profile.sampleCount,
          },
        })
      : getString("audit-detector-benford-summary-clear", {
          args: {
            mad: formatMad(profile.mad),
            count: profile.sampleCount,
          },
        }),
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
          message: getString("audit-detector-invalid-percentages-finding", {
            args: {
              cell: formatCellRef(row.index, cell.columnIndex),
              value: cell.rawText,
            },
          }),
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
      ? getString("audit-detector-invalid-percentages-summary-hit", {
          args: { count: findings.length },
        })
      : getString("audit-detector-invalid-percentages-summary-clear"),
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
          message: getString("audit-detector-invalid-pvalues-finding", {
            args: {
              cell: formatCellRef(row.index, cell.columnIndex),
              value: cell.rawText,
            },
          }),
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
      ? getString("audit-detector-invalid-pvalues-summary-hit", {
          args: { count: findings.length },
        })
      : getString("audit-detector-invalid-pvalues-summary-clear"),
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
    if (
      numericCells.length < 3 ||
      numericCells.length !== analyzedRows.length
    ) {
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
      message: getString("audit-detector-repeated-columns-finding", {
        args: {
          columns: columnIndices
            .map((columnIndex) => formatColumnLabel(table, columnIndex))
            .join(", "),
          rows: analyzedRows.length,
          signature: signature.replace(/\u241f/g, " | "),
        },
      }),
      columnIndices,
      evidence: [signature.replace(/\u241f/g, " | ")],
    });
  }

  return {
    detectorId: "repeated-numeric-columns",
    applicability: analyzedRows.length >= 3 ? "applied" : "skipped",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? getString("audit-detector-repeated-columns-summary-hit", {
          args: { count: findings.length },
        })
      : getString("audit-detector-repeated-columns-summary-clear"),
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
      message: getString("audit-detector-uniform-columns-finding", {
        args: {
          column: formatColumnLabel(table, columnIndex),
          value: dominantValue,
          count: dominantCount,
          total: numericCells.length,
        },
      }),
      columnIndices: [columnIndex],
      evidence: [dominantValue],
    });
  }

  return {
    detectorId: "uniform-numeric-columns",
    applicability: analyzedRows.length >= 3 ? "applied" : "skipped",
    severity: "info",
    summary: findings.length
      ? getString("audit-detector-uniform-columns-summary-hit", {
          args: { count: findings.length },
        })
      : getString("audit-detector-uniform-columns-summary-clear"),
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
  buildFinding: (rows: TableRow[], signature: string) => DetectorFinding,
): DetectorFinding[] {
  const findings: DetectorFinding[] = [];

  for (const [signature, rows] of groupedRows.entries()) {
    if (rows.length < 2) {
      continue;
    }
    findings.push(buildFinding(rows, signature.replace(/\u241f/g, " | ")));
  }

  return findings;
}

function getLeadingDigit(value: number): number | undefined {
  const absoluteValue = Math.abs(value);
  if (!Number.isFinite(absoluteValue) || absoluteValue === 0) {
    return undefined;
  }

  const match = absoluteValue.toExponential().match(/^([1-9])/);
  return match ? Number(match[1]) : undefined;
}

function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatMad(mad: number): string {
  return mad.toFixed(3);
}

function formatCellRef(rowIndex: number, columnIndex: number): string {
  return `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
}

function formatColumnLabel(table: TableDocument, columnIndex: number): string {
  const columnRef = String.fromCharCode(65 + columnIndex);
  const headerText = table.header?.[columnIndex]?.trim();
  return headerText ? `${headerText} (${columnRef})` : columnRef;
}
