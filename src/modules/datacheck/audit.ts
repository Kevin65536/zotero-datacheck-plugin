import type {
  AuditReport,
  DetectorFinding,
  DetectorResult,
  ParsedNumericValue,
  TableCell,
  TableDocument,
  TableRow,
} from "./types";
import type { AuditDetectorId } from "./detectors";
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

interface BuildAuditReportOptions {
  enabledDetectorIds?: AuditDetectorId[];
}

interface DetectorDefinition {
  id: AuditDetectorId;
  run: Detector;
}

const BENFORD_EXPECTED_RATIOS = [
  0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046,
];
const SECOND_DIGIT_BENFORD_EXPECTED_RATIOS = Array.from(
  { length: 10 },
  (_, digit) => {
    let probability = 0;
    for (let leadingDigit = 1; leadingDigit <= 9; leadingDigit += 1) {
      probability += Math.log10(1 + 1 / (leadingDigit * 10 + digit));
    }
    return probability;
  },
);
const TERMINAL_DIGIT_EXPECTED_RATIOS = Array.from({ length: 10 }, () => 0.1);
const BENFORD_MIN_SAMPLE_COUNT = 20;
const BENFORD_WARNING_MAD_THRESHOLD = 0.015;
const SECOND_DIGIT_BENFORD_WARNING_MAD_THRESHOLD = 0.01;

const TERMINAL_DIGIT_MIN_SAMPLE_COUNT = 20;
const TERMINAL_DIGIT_CHI_SQUARE_THRESHOLD = 16.92;
const ROUNDING_HEAP_MIN_SAMPLE_COUNT = 10;
const ROUNDING_HEAP_RATIO_THRESHOLD = 0.7;
const PVALUE_CLUSTER_MIN_SAMPLE_COUNT = 6;
const LOW_VARIANCE_MIN_SAMPLE_COUNT = 5;
const LOW_VARIANCE_CV_THRESHOLD = 0.02;
const LOW_VARIANCE_RANGE_RATIO_THRESHOLD = 0.05;
const MAX_NEAR_DUPLICATE_FINDINGS = 12;

const DETECTORS: readonly DetectorDefinition[] = [
  { id: "duplicate-rows", run: detectDuplicateRows },
  { id: "near-duplicate-rows", run: detectNearDuplicateRows },
  {
    id: "duplicate-numeric-sequences",
    run: detectDuplicateNumericSequences,
  },
  { id: "benford-deviation", run: detectBenfordDeviation },
  {
    id: "second-digit-benford-deviation",
    run: detectSecondDigitBenfordDeviation,
  },
  {
    id: "terminal-digit-preference",
    run: detectTerminalDigitPreference,
  },
  { id: "rounding-heaping", run: detectRoundingHeaping },
  {
    id: "p-value-threshold-clustering",
    run: detectPValueThresholdClustering,
  },
  { id: "repeated-numeric-columns", run: detectRepeatedNumericColumns },
  { id: "uniform-numeric-columns", run: detectUniformNumericColumns },
  {
    id: "low-variance-numeric-columns",
    run: detectLowVarianceNumericColumns,
  },
  { id: "invalid-percentages", run: detectInvalidPercentages },
  { id: "invalid-p-values", run: detectInvalidPValues },
];

export function buildAuditReport(
  table: TableDocument,
  options: BuildAuditReportOptions = {},
): AuditReport {
  const detectorResults = resolveEnabledDetectors(
    options.enabledDetectorIds,
  ).map((detector) => detector.run(table));
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
  return buildDigitDistributionProfile(
    getPlainNumericCells(table),
    BENFORD_EXPECTED_RATIOS.map((_, index) => index + 1),
    BENFORD_EXPECTED_RATIOS,
    (cell) => getLeadingDigit(cell.parsedNumeric!.value),
  );
}

export function buildSecondDigitBenfordProfile(
  table: TableDocument,
): BenfordProfile {
  return buildDigitDistributionProfile(
    getPlainNumericCells(table),
    SECOND_DIGIT_BENFORD_EXPECTED_RATIOS.map((_, index) => index),
    SECOND_DIGIT_BENFORD_EXPECTED_RATIOS,
    (cell) =>
      getSecondSignificantDigit(
        cell.parsedNumeric?.normalizedText ?? cell.normalizedText,
      ),
  );
}

export function buildTerminalDigitProfile(
  table: TableDocument,
): BenfordProfile {
  return buildDigitDistributionProfile(
    getNonPValueNumericCells(table),
    TERMINAL_DIGIT_EXPECTED_RATIOS.map((_, index) => index),
    TERMINAL_DIGIT_EXPECTED_RATIOS,
    (cell) => getTerminalDigit(cell.normalizedText),
  );
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

function detectNearDuplicateRows(table: TableDocument): DetectorResult {
  const analyzedRows = getAnalyzedRows(table);
  const findings: DetectorFinding[] = [];

  for (let leftIndex = 0; leftIndex < analyzedRows.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < analyzedRows.length;
      rightIndex += 1
    ) {
      const comparison = compareRows(
        analyzedRows[leftIndex],
        analyzedRows[rightIndex],
      );
      if (
        comparison.comparedCellCount < 4 ||
        comparison.matchingCellCount === comparison.comparedCellCount ||
        comparison.matchingCellCount < comparison.comparedCellCount - 1
      ) {
        continue;
      }

      const similarity =
        comparison.matchingCellCount / comparison.comparedCellCount;
      const hasMatchingNumericBackbone =
        comparison.comparedNumericCellCount >= 2 &&
        comparison.matchingNumericCellCount ===
          comparison.comparedNumericCellCount &&
        comparison.differingColumnIndices.length <= 2;
      if (!hasMatchingNumericBackbone && similarity < 0.8) {
        continue;
      }

      findings.push({
        message: getString("audit-detector-near-duplicate-rows-finding", {
          args: {
            left: analyzedRows[leftIndex].index + 1,
            right: analyzedRows[rightIndex].index + 1,
            matches: comparison.matchingCellCount,
            total: comparison.comparedCellCount,
            columns: comparison.differingColumnIndices
              .map((columnIndex) => formatColumnLabel(table, columnIndex))
              .join(", "),
          },
        }),
        rowIndices: [
          analyzedRows[leftIndex].index,
          analyzedRows[rightIndex].index,
        ],
        columnIndices: comparison.differingColumnIndices,
      });

      if (findings.length >= MAX_NEAR_DUPLICATE_FINDINGS) {
        break;
      }
    }

    if (findings.length >= MAX_NEAR_DUPLICATE_FINDINGS) {
      break;
    }
  }

  return {
    detectorId: "near-duplicate-rows",
    applicability: analyzedRows.length >= 2 ? "applied" : "skipped",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? getString("audit-detector-near-duplicate-rows-summary-hit", {
          args: { count: findings.length },
        })
      : getString("audit-detector-near-duplicate-rows-summary-clear"),
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

function detectSecondDigitBenfordDeviation(
  table: TableDocument,
): DetectorResult {
  const profile = buildSecondDigitBenfordProfile(table);
  if (profile.sampleCount < BENFORD_MIN_SAMPLE_COUNT) {
    return {
      detectorId: "second-digit-benford-deviation",
      applicability: "skipped",
      severity: "info",
      summary: getString("audit-detector-second-digit-benford-summary-skip", {
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
    profile.mad >= SECOND_DIGIT_BENFORD_WARNING_MAD_THRESHOLD
      ? [
          {
            message: getString("audit-detector-second-digit-benford-finding", {
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
    detectorId: "second-digit-benford-deviation",
    applicability: "applied",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? getString("audit-detector-second-digit-benford-summary-hit", {
          args: {
            mad: formatMad(profile.mad),
            count: profile.sampleCount,
          },
        })
      : getString("audit-detector-second-digit-benford-summary-clear", {
          args: {
            mad: formatMad(profile.mad),
            count: profile.sampleCount,
          },
        }),
    findings,
  };
}

function detectTerminalDigitPreference(table: TableDocument): DetectorResult {
  const digitCounts = Array.from({ length: 10 }, () => 0);

  for (const cell of getNonPValueNumericCells(table)) {
    const terminalDigit = getTerminalDigit(cell.normalizedText);
    if (terminalDigit === undefined) {
      continue;
    }

    digitCounts[terminalDigit] += 1;
  }

  const sampleCount = digitCounts.reduce((count, value) => count + value, 0);
  if (sampleCount < TERMINAL_DIGIT_MIN_SAMPLE_COUNT) {
    return {
      detectorId: "terminal-digit-preference",
      applicability: "skipped",
      severity: "info",
      summary: getString("audit-detector-terminal-digit-summary-skip", {
        args: {
          count: sampleCount,
          minimum: TERMINAL_DIGIT_MIN_SAMPLE_COUNT,
        },
      }),
      findings: [],
    };
  }

  const chiSquare = computeUniformChiSquare(digitCounts);
  const zeroFiveRatio =
    ((digitCounts[0] ?? 0) + (digitCounts[5] ?? 0)) / sampleCount;
  const topDigits = digitCounts
    .map((count, digit) => ({
      digit,
      count,
      ratio: count / sampleCount,
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 3)
    .map((entry) => `${entry.digit} (${formatRatio(entry.ratio)})`)
    .join(", ");
  const findings: DetectorFinding[] =
    chiSquare >= TERMINAL_DIGIT_CHI_SQUARE_THRESHOLD
      ? [
          {
            message: getString("audit-detector-terminal-digit-finding", {
              args: {
                digits: topDigits,
                chiSquare: formatStatistic(chiSquare),
                zeroFive: formatRatio(zeroFiveRatio),
                count: sampleCount,
              },
            }),
            evidence: topDigits ? [topDigits] : undefined,
          },
        ]
      : [];

  return {
    detectorId: "terminal-digit-preference",
    applicability: "applied",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? getString("audit-detector-terminal-digit-summary-hit", {
          args: {
            chiSquare: formatStatistic(chiSquare),
            count: sampleCount,
          },
        })
      : getString("audit-detector-terminal-digit-summary-clear", {
          args: {
            chiSquare: formatStatistic(chiSquare),
            count: sampleCount,
          },
        }),
    findings,
  };
}

function detectRoundingHeaping(table: TableDocument): DetectorResult {
  let integerCount = 0;
  let integerRoundedCount = 0;
  let decimalCount = 0;
  let decimalRoundedCount = 0;
  let decimalZeroCount = 0;
  let decimalFiveCount = 0;

  for (const cell of getNonPValueNumericCells(table)) {
    const numericText = stripPercentageSuffix(cell.normalizedText);
    if (numericText.includes(".")) {
      decimalCount += 1;
      const decimalPart = numericText.split(".")[1] ?? "";
      if (/^0+$/.test(decimalPart)) {
        decimalRoundedCount += 1;
        decimalZeroCount += 1;
      } else if (/^50*$/.test(decimalPart)) {
        decimalRoundedCount += 1;
        decimalFiveCount += 1;
      }
      continue;
    }

    integerCount += 1;
    if (Number.isInteger(cell.parsedNumeric?.value) && isMultipleOfFive(cell)) {
      integerRoundedCount += 1;
    }
  }

  const findings: DetectorFinding[] = [];
  const applicable =
    integerCount >= ROUNDING_HEAP_MIN_SAMPLE_COUNT ||
    decimalCount >= ROUNDING_HEAP_MIN_SAMPLE_COUNT;

  if (
    integerCount >= ROUNDING_HEAP_MIN_SAMPLE_COUNT &&
    integerRoundedCount / integerCount >= ROUNDING_HEAP_RATIO_THRESHOLD
  ) {
    findings.push({
      message: getString("audit-detector-rounding-heaping-finding-integer", {
        args: {
          count: integerRoundedCount,
          total: integerCount,
          ratio: formatRatio(integerRoundedCount / integerCount),
        },
      }),
    });
  }

  if (
    decimalCount >= ROUNDING_HEAP_MIN_SAMPLE_COUNT &&
    decimalRoundedCount / decimalCount >= ROUNDING_HEAP_RATIO_THRESHOLD
  ) {
    findings.push({
      message: getString("audit-detector-rounding-heaping-finding-decimal", {
        args: {
          count: decimalRoundedCount,
          total: decimalCount,
          ratio: formatRatio(decimalRoundedCount / decimalCount),
          zeroCount: decimalZeroCount,
          fiveCount: decimalFiveCount,
        },
      }),
    });
  }

  return {
    detectorId: "rounding-heaping",
    applicability: applicable ? "applied" : "skipped",
    severity: findings.length ? "warning" : "info",
    summary: !applicable
      ? getString("audit-detector-rounding-heaping-summary-skip", {
          args: { minimum: ROUNDING_HEAP_MIN_SAMPLE_COUNT },
        })
      : findings.length
        ? getString("audit-detector-rounding-heaping-summary-hit", {
            args: { count: findings.length },
          })
        : getString("audit-detector-rounding-heaping-summary-clear"),
    findings,
  };
}

function detectPValueThresholdClustering(table: TableDocument): DetectorResult {
  const exactPValues = getPValueCells(table)
    .map((cell) => cell.parsedNumeric)
    .filter((value): value is ParsedNumericValue => value?.kind === "p-value")
    .filter((value) => !value.comparator || value.comparator === "=")
    .map((value) => value.value)
    .filter((value) => value >= 0.04 && value <= 0.06);

  if (exactPValues.length < PVALUE_CLUSTER_MIN_SAMPLE_COUNT) {
    return {
      detectorId: "p-value-threshold-clustering",
      applicability: "skipped",
      severity: "info",
      summary: getString("audit-detector-pvalue-clustering-summary-skip", {
        args: {
          count: exactPValues.length,
          minimum: PVALUE_CLUSTER_MIN_SAMPLE_COUNT,
        },
      }),
      findings: [],
    };
  }

  const leftCount = exactPValues.filter(
    (value) => value >= 0.045 && value < 0.05,
  ).length;
  const exactCount = exactPValues.filter(
    (value) => Math.abs(value - 0.05) < 1e-9,
  ).length;
  const rightCount = exactPValues.filter(
    (value) => value > 0.05 && value <= 0.055,
  ).length;
  const suspiciousCount = leftCount + exactCount;
  const findings: DetectorFinding[] =
    suspiciousCount >= 4 &&
    suspiciousCount >= rightCount + 2 &&
    suspiciousCount / exactPValues.length >= 0.5
      ? [
          {
            message: getString("audit-detector-pvalue-clustering-finding", {
              args: {
                left: leftCount,
                exact: exactCount,
                right: rightCount,
                total: exactPValues.length,
              },
            }),
          },
        ]
      : [];

  return {
    detectorId: "p-value-threshold-clustering",
    applicability: "applied",
    severity: findings.length ? "warning" : "info",
    summary: findings.length
      ? getString("audit-detector-pvalue-clustering-summary-hit", {
          args: { count: exactPValues.length },
        })
      : getString("audit-detector-pvalue-clustering-summary-clear", {
          args: { count: exactPValues.length },
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

function detectLowVarianceNumericColumns(table: TableDocument): DetectorResult {
  const analyzedRows = getAnalyzedRows(table);
  const findings: DetectorFinding[] = [];

  for (let columnIndex = 0; columnIndex < table.columnCount; columnIndex += 1) {
    const numericCells = analyzedRows
      .map((row) => row.cells[columnIndex])
      .filter((cell) => {
        const kind = cell?.parsedNumeric?.kind;
        return kind === "number" || kind === "percentage";
      });

    if (numericCells.length < LOW_VARIANCE_MIN_SAMPLE_COUNT) {
      continue;
    }

    const values = numericCells.map((cell) => cell.parsedNumeric!.value);
    const uniqueCount = new Set(
      numericCells.map((cell) => cell.parsedNumeric!.normalizedText),
    ).size;
    if (uniqueCount < 3) {
      continue;
    }

    const mean = computeMean(values);
    const standardDeviation = computeStandardDeviation(values, mean);
    const maxValue = Math.max(...values);
    const minValue = Math.min(...values);
    const scale = Math.max(Math.abs(mean), 1e-6);
    const coefficientOfVariation = standardDeviation / scale;
    const rangeRatio = (maxValue - minValue) / scale;

    if (
      coefficientOfVariation > LOW_VARIANCE_CV_THRESHOLD ||
      rangeRatio > LOW_VARIANCE_RANGE_RATIO_THRESHOLD
    ) {
      continue;
    }

    findings.push({
      message: getString("audit-detector-low-variance-columns-finding", {
        args: {
          column: formatColumnLabel(table, columnIndex),
          count: numericCells.length,
          unique: uniqueCount,
          cv: formatStatistic(coefficientOfVariation, 3),
          range: formatStatistic(maxValue - minValue, 3),
        },
      }),
      columnIndices: [columnIndex],
    });
  }

  return {
    detectorId: "low-variance-numeric-columns",
    applicability:
      analyzedRows.length >= LOW_VARIANCE_MIN_SAMPLE_COUNT
        ? "applied"
        : "skipped",
    severity: findings.length ? "info" : "info",
    summary: findings.length
      ? getString("audit-detector-low-variance-columns-summary-hit", {
          args: { count: findings.length },
        })
      : getString("audit-detector-low-variance-columns-summary-clear"),
    findings,
  };
}

function getAnalyzedRows(table: TableDocument): TableRow[] {
  return table.rows.filter((row) => row.index !== table.headerRowIndex);
}

function resolveEnabledDetectors(
  enabledDetectorIds: AuditDetectorId[] | undefined,
): readonly DetectorDefinition[] {
  if (enabledDetectorIds === undefined) {
    return DETECTORS;
  }

  const enabledSet = new Set(enabledDetectorIds);
  return DETECTORS.filter((detector) => enabledSet.has(detector.id));
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

function compareRows(left: TableRow, right: TableRow) {
  let comparedCellCount = 0;
  let matchingCellCount = 0;
  let comparedNumericCellCount = 0;
  let matchingNumericCellCount = 0;
  const differingColumnIndices: number[] = [];

  for (let columnIndex = 0; columnIndex < left.cells.length; columnIndex += 1) {
    const leftCell = left.cells[columnIndex];
    const rightCell = right.cells[columnIndex];
    const leftValue = left.cells[columnIndex]?.normalizedText ?? "";
    const rightValue = right.cells[columnIndex]?.normalizedText ?? "";
    if (!leftValue && !rightValue) {
      continue;
    }

    comparedCellCount += 1;
    if (leftCell?.parsedNumeric && rightCell?.parsedNumeric) {
      comparedNumericCellCount += 1;
      if (leftValue === rightValue) {
        matchingNumericCellCount += 1;
      }
    }

    if (leftValue === rightValue) {
      matchingCellCount += 1;
    } else {
      differingColumnIndices.push(columnIndex);
    }
  }

  return {
    comparedCellCount,
    matchingCellCount,
    comparedNumericCellCount,
    matchingNumericCellCount,
    differingColumnIndices,
  };
}

function getPlainNumericCells(table: TableDocument): TableCell[] {
  return getAnalyzedRows(table)
    .flatMap((row) => row.cells)
    .filter((cell) => cell.parsedNumeric?.kind === "number");
}

function getNonPValueNumericCells(table: TableDocument): TableCell[] {
  return getAnalyzedRows(table)
    .flatMap((row) => row.cells)
    .filter((cell) => {
      const kind = cell.parsedNumeric?.kind;
      return kind === "number" || kind === "percentage";
    });
}

function getPValueCells(table: TableDocument): TableCell[] {
  return getAnalyzedRows(table)
    .flatMap((row) => row.cells)
    .filter((cell) => cell.parsedNumeric?.kind === "p-value");
}

function buildDigitDistributionProfile(
  cells: TableCell[],
  digits: number[],
  expectedRatios: number[],
  getDigit: (cell: TableCell) => number | undefined,
): BenfordProfile {
  const digitCounts = new Map<number, number>(
    digits.map((digit) => [digit, 0]),
  );

  for (const cell of cells) {
    const digit = getDigit(cell);
    if (digit === undefined || !digitCounts.has(digit)) {
      continue;
    }

    digitCounts.set(digit, (digitCounts.get(digit) ?? 0) + 1);
  }

  const sampleCount = digits.reduce((count, digit) => {
    return count + (digitCounts.get(digit) ?? 0);
  }, 0);
  const bins = digits.map((digit, index) => {
    const observedCount = digitCounts.get(digit) ?? 0;
    const observedRatio = sampleCount ? observedCount / sampleCount : 0;
    const expectedRatio = expectedRatios[index] ?? 0;
    return {
      digit,
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

function getLeadingDigit(value: number): number | undefined {
  const absoluteValue = Math.abs(value);
  if (!Number.isFinite(absoluteValue) || absoluteValue === 0) {
    return undefined;
  }

  const match = absoluteValue.toExponential().match(/^([1-9])/);
  return match ? Number(match[1]) : undefined;
}

function getSecondSignificantDigit(text: string): number | undefined {
  const digits = stripPercentageSuffix(text).replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length < 2) {
    return undefined;
  }

  return Number(digits[1]);
}

function getTerminalDigit(text: string): number | undefined {
  const digits = stripPercentageSuffix(text).replace(/\D/g, "");
  if (!digits.length) {
    return undefined;
  }

  return Number(digits[digits.length - 1]);
}

function stripPercentageSuffix(text: string): string {
  return text.endsWith("%") ? text.slice(0, -1) : text;
}

function isMultipleOfFive(cell: TableCell): boolean {
  const value = cell.parsedNumeric?.value;
  if (value === undefined) {
    return false;
  }

  return Math.abs(value % 5) < 1e-9;
}

function computeUniformChiSquare(observedCounts: number[]): number {
  const totalCount = observedCounts.reduce((sum, count) => sum + count, 0);
  if (!totalCount) {
    return 0;
  }

  const expectedCount = totalCount / observedCounts.length;
  return observedCounts.reduce((sum, observedCount) => {
    return sum + (observedCount - expectedCount) ** 2 / expectedCount;
  }, 0);
}

function computeMean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function computeStandardDeviation(values: number[], mean: number): number {
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
}

function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatStatistic(value: number, fractionDigits = 2): string {
  return value.toFixed(fractionDigits);
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
