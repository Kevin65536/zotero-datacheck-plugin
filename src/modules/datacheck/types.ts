export interface ReaderAuditContext {
  attachmentID: number;
  attachmentKey: string;
  itemTitle: string;
  pageNumber?: number;
  selectedText: string;
  selectedTextLength: number;
  capturedAt: string;
  structuredRows?: string[][];
  selectionRectCount?: number;
  extractionDiagnostics?: string[];
}

export interface PageTextEntry {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

export interface TableSelectionDraft {
  source:
    | "reader-text-selection"
    | "reader-structured-selection"
    | "reader-pdf-table-scan";
  attachmentID: number;
  attachmentKey: string;
  itemTitle: string;
  pageNumber?: number;
  selectedText: string;
  selectedTextLength: number;
  capturedAt: string;
  structuredRows?: string[][];
  selectionRectCount?: number;
  extractionDiagnostics?: string[];
}

export interface ReaderTableScanResult {
  attachmentID: number;
  attachmentKey: string;
  itemTitle: string;
  capturedAt: string;
  pageCount: number;
  tableDrafts: TableSelectionDraft[];
  diagnostics: string[];
}

export interface ReaderTableScanDebugBlock {
  rowCount: number;
  maxColumnCount: number;
  preview: string;
}

export interface ReaderTableScanDebugPage {
  pageNumber: number;
  entryCount: number;
  rowCount: number;
  rowBlockCount: number;
  detectedTableCount: number;
  maxCellsInRow: number;
  maxDetectedColumnCount: number;
  textPreview: string;
  blockSummaries: ReaderTableScanDebugBlock[];
}

export interface ReaderTableScanDebugResult {
  attachmentID: number;
  attachmentKey: string;
  itemTitle: string;
  capturedAt: string;
  pageCount: number;
  diagnostics: string[];
  pages: ReaderTableScanDebugPage[];
}

export interface ParsedNumericValue {
  value: number;
  kind: "number" | "percentage" | "p-value";
  comparator?: "<" | ">" | "<=" | ">=" | "=";
  normalizedText: string;
}

export interface TableCell {
  rawText: string;
  normalizedText: string;
  rowIndex: number;
  columnIndex: number;
  parsedNumeric?: ParsedNumericValue;
}

export interface TableRow {
  index: number;
  cells: TableCell[];
}

export interface TableDocument {
  source: TableSelectionDraft["source"];
  attachmentID: number;
  attachmentKey: string;
  itemTitle: string;
  pageNumber?: number;
  capturedAt: string;
  rawText: string;
  selectionRectCount?: number;
  header?: string[];
  headerRowIndex?: number;
  rows: TableRow[];
  rowCount: number;
  columnCount: number;
  numericCellCount: number;
  reconstructionWarnings: string[];
}

export interface DetectorFinding {
  message: string;
  rowIndices?: number[];
  columnIndices?: number[];
  cellRefs?: string[];
  evidence?: string[];
}

export interface DetectorResult {
  detectorId: string;
  applicability: "applied" | "skipped";
  severity: "info" | "warning";
  summary: string;
  findings: DetectorFinding[];
}

export interface AuditReport {
  createdAt: string;
  summary: string;
  tableDiagnostics: string[];
  detectorResults: DetectorResult[];
  findingCount: number;
}
