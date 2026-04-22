import type {
  PageTextEntry,
  ReaderAuditContext,
  ReaderTableScanDebugResult,
  ReaderTableScanResult,
  TableSelectionDraft,
} from "./types";
import { getString } from "../../utils/locale";

interface LocalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type SelectionTextEntry = PageTextEntry;

interface StructuredCell extends LocalRect {
  text: string;
  centerX: number;
}

interface TableLikeRow extends LocalRect {
  centerY: number;
  cells: StructuredCell[];
}

interface TableCaptionAnchor extends LocalRect {
  centerY: number;
  text: string;
}

interface StructuredSelectionResult {
  rows: string[][];
  selectionRectCount?: number;
  diagnostics: string[];
}

interface SelectionAnnotationSnapshot {
  text?: string;
  position: {
    pageIndex: number;
    rects: number[][];
  };
}

interface RememberedReaderSelection {
  tabID: string;
  annotation?: SelectionAnnotationSnapshot;
  selectedText: string;
}

let rememberedReaderSelection: RememberedReaderSelection | undefined;

const MIN_TABLE_COLUMNS = 2;
const MIN_TABLE_ROWS = 2;
const TABLE_CAPTION_PATTERN = /^table\s+\d+[\.:]?\s+\S+/i;

export function hydrateSelectionAnnotationText(
  reader: any,
  annotation?: _ZoteroTypes.Annotations.AnnotationJson,
): string {
  const existingText =
    typeof annotation?.text === "string" ? annotation.text.trim() : "";
  if (existingText) {
    return existingText;
  }

  const fallbackText = getSelectedText(
    reader,
    snapshotSelectionAnnotation(annotation),
  ).trim();
  if (!fallbackText || !annotation) {
    return fallbackText;
  }

  try {
    annotation.text = fallbackText;
  } catch {
    // Some cross-compartment annotation objects may reject writes.
  }

  return fallbackText;
}

export function rememberReaderSelection(
  reader: any,
  annotation?: _ZoteroTypes.Annotations.AnnotationJson,
) {
  const tabID = reader?.tabID;
  if (!tabID) {
    return;
  }

  const currentAnnotation =
    snapshotSelectionAnnotation(annotation) ?? getSelectionAnnotation(reader);
  rememberedReaderSelection = {
    tabID,
    annotation: currentAnnotation,
    selectedText: getSelectedText(reader, currentAnnotation),
  };
}

function getActiveReader(): any | null {
  const tabs = ztoolkit.getGlobal("Zotero_Tabs") as any;
  const selectedTabID = tabs?.selectedID;
  if (!selectedTabID) {
    return null;
  }

  return (Zotero.Reader.getByTabID(selectedTabID) as any) ?? null;
}

export async function getActiveReaderContext(): Promise<ReaderAuditContext | null> {
  const reader = getActiveReader();
  if (!reader?.itemID) {
    return null;
  }

  const { attachmentID, attachmentKey, itemTitle } =
    await getReaderAttachmentMetadata(reader);

  const rememberedSelection =
    rememberedReaderSelection?.tabID === reader.tabID
      ? rememberedReaderSelection
      : undefined;
  const liveSelectionAnnotation = getSelectionAnnotation(reader);
  const selectionAnnotation =
    liveSelectionAnnotation ?? rememberedSelection?.annotation;
  const structuredSelection = await extractStructuredSelection(
    reader,
    selectionAnnotation,
  );
  if (
    !liveSelectionAnnotation &&
    (rememberedSelection?.annotation ||
      rememberedSelection?.selectedText.trim())
  ) {
    structuredSelection.diagnostics.unshift(
      getString("reader-diagnostic-preserved-selection"),
    );
  }

  let selectedText = getSelectedText(reader, selectionAnnotation);
  if (!selectedText.trim() && rememberedSelection?.selectedText.trim()) {
    selectedText = rememberedSelection.selectedText;
  }
  if (structuredSelection.rows.length) {
    selectedText = structuredSelection.rows
      .map((row) => row.join("\t"))
      .join("\n");
  }

  return {
    attachmentID,
    attachmentKey,
    itemTitle,
    pageNumber: getReaderCurrentPageNumber(reader),
    selectedText,
    selectedTextLength: selectedText.trim().length,
    capturedAt: new Date().toISOString(),
    structuredRows: structuredSelection.rows.length
      ? structuredSelection.rows
      : undefined,
    selectionRectCount: structuredSelection.selectionRectCount,
    extractionDiagnostics: structuredSelection.diagnostics,
  };
}

export function createTableSelectionDraft(
  context: ReaderAuditContext,
): TableSelectionDraft {
  return {
    source: context.structuredRows?.length
      ? "reader-structured-selection"
      : "reader-text-selection",
    attachmentID: context.attachmentID,
    attachmentKey: context.attachmentKey,
    itemTitle: context.itemTitle,
    pageNumber: context.pageNumber,
    selectedText: context.selectedText,
    selectedTextLength: context.selectedTextLength,
    capturedAt: context.capturedAt,
    structuredRows: context.structuredRows,
    selectionRectCount: context.selectionRectCount,
    extractionDiagnostics: context.extractionDiagnostics,
  };
}

export function detectTableDraftsFromPageEntries({
  attachmentID,
  attachmentKey,
  itemTitle,
  pageNumber,
  capturedAt,
  entries,
}: {
  attachmentID: number;
  attachmentKey: string;
  itemTitle: string;
  pageNumber: number;
  capturedAt: string;
  entries: PageTextEntry[];
}): TableSelectionDraft[] {
  const rows = buildTableRows(entries);
  const rowBlocks = collectTableRowBlocks(rows);
  const captionAnchors = collectTableCaptionAnchors(rows);
  const captionedBlocks = matchCaptionAnchorsToRowBlocks(
    captionAnchors,
    rowBlocks,
  );

  return captionedBlocks.flatMap(({ rowBlock, caption }, blockIndex) => {
    const captionAlignedBlock = clipRowBlockToCaptionLane(rowBlock, caption);
    const structuredRows = normalizeDetectedTableRows(captionAlignedBlock);
    if (!structuredRows.length) {
      return [];
    }

    const selectedText = structuredRows.map((row) => row.join("\t")).join("\n");
    if (!selectedText.trim()) {
      return [];
    }

    return [
      {
        source: "reader-pdf-table-scan",
        attachmentID,
        attachmentKey,
        itemTitle,
        pageNumber,
        capturedAt,
        selectedText,
        selectedTextLength: selectedText.trim().length,
        structuredRows,
        extractionDiagnostics: [
          getString("reader-diagnostic-pdf-table-detected", {
            args: {
              index: blockIndex + 1,
              page: pageNumber,
              rows: structuredRows.length,
              cols: Math.max(...structuredRows.map((row) => row.length)),
            },
          }),
          `caption=${caption.text}`,
        ],
      },
    ];
  });
}

export async function scanActiveReaderForTables(
  reader?: any,
): Promise<ReaderTableScanResult | null> {
  const activeReader = reader ?? getActiveReader();
  if (!activeReader?.itemID) {
    return null;
  }

  const { attachmentID, attachmentKey, itemTitle } =
    await getReaderAttachmentMetadata(activeReader);
  const capturedAt = new Date().toISOString();
  const diagnostics: string[] = [];
  const pdfDocument = getReaderPdfDocument(activeReader);

  if (!pdfDocument?.getPage) {
    diagnostics.push(getString("reader-diagnostic-pdf-document-unavailable"));
    return {
      attachmentID,
      attachmentKey,
      itemTitle,
      capturedAt,
      pageCount: 0,
      tableDrafts: [],
      diagnostics,
    };
  }

  const pageCount = Number(pdfDocument.numPages);
  const safePageCount = Number.isFinite(pageCount) ? pageCount : 0;
  const tableDrafts: TableSelectionDraft[] = [];

  for (let pageNumber = 1; pageNumber <= safePageCount; pageNumber += 1) {
    try {
      const entries = await getPdfPageTextEntries(
        activeReader,
        pdfDocument,
        pageNumber,
      );
      if (!entries.length) {
        continue;
      }

      tableDrafts.push(
        ...detectTableDraftsFromPageEntries({
          attachmentID,
          attachmentKey,
          itemTitle,
          pageNumber,
          capturedAt,
          entries,
        }),
      );
    } catch (error) {
      diagnostics.push(
        getString("reader-diagnostic-pdf-page-scan-error", {
          args: { page: pageNumber },
        }),
      );
      Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    attachmentID,
    attachmentKey,
    itemTitle,
    capturedAt,
    pageCount: safePageCount,
    tableDrafts,
    diagnostics,
  };
}

export async function debugScanActiveReaderForTables(
  reader?: any,
): Promise<ReaderTableScanDebugResult | null> {
  const activeReader = reader ?? getActiveReader();
  if (!activeReader?.itemID) {
    return null;
  }

  const { attachmentID, attachmentKey, itemTitle } =
    await getReaderAttachmentMetadata(activeReader);
  const capturedAt = new Date().toISOString();
  const diagnostics: string[] = [];
  const pdfDocument = getReaderPdfDocument(activeReader);

  if (!pdfDocument?.getPage) {
    diagnostics.push(getString("reader-diagnostic-pdf-document-unavailable"));
    return {
      attachmentID,
      attachmentKey,
      itemTitle,
      capturedAt,
      pageCount: 0,
      diagnostics,
      pages: [],
    };
  }

  const pageCount = Number(pdfDocument.numPages);
  const safePageCount = Number.isFinite(pageCount) ? pageCount : 0;
  const pages: ReaderTableScanDebugResult["pages"] = [];

  for (let pageNumber = 1; pageNumber <= safePageCount; pageNumber += 1) {
    try {
      const entries = await getPdfPageTextEntries(
        activeReader,
        pdfDocument,
        pageNumber,
      );
      const rows = buildTableRows(entries);
      const rowBlocks = collectTableRowBlocks(rows);
      const normalizedTables = rowBlocks
        .map((rowBlock) => normalizeDetectedTableRows(rowBlock))
        .filter((structuredRows) => structuredRows.length);

      pages.push({
        pageNumber,
        entryCount: entries.length,
        rowCount: rows.length,
        rowBlockCount: rowBlocks.length,
        detectedTableCount: normalizedTables.length,
        maxCellsInRow: Math.max(...rows.map((row) => row.cells.length), 0),
        maxDetectedColumnCount: Math.max(
          ...normalizedTables.flatMap((rows) => rows.map((row) => row.length)),
          0,
        ),
        textPreview: entries
          .slice(0, 12)
          .map((entry) => entry.text)
          .join(" | "),
        blockSummaries: rowBlocks.slice(0, 3).map((rowBlock) => ({
          rowCount: rowBlock.length,
          maxColumnCount: Math.max(...rowBlock.map((row) => row.cells.length), 0),
          preview: rowBlock[0]?.cells.map((cell) => cell.text).join(" | ") ?? "",
        })),
      });
    } catch (error) {
      diagnostics.push(
        getString("reader-diagnostic-pdf-page-scan-error", {
          args: { page: pageNumber },
        }),
      );
      Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    attachmentID,
    attachmentKey,
    itemTitle,
    capturedAt,
    pageCount: safePageCount,
    diagnostics,
    pages,
  };
}

async function getReaderAttachmentMetadata(reader: any): Promise<{
  attachmentID: number;
  attachmentKey: string;
  itemTitle: string;
}> {
  const attachment = (await Zotero.Items.getAsync(reader.itemID)) as Zotero.Item;
  const parentItem = attachment.parentID
    ? ((await Zotero.Items.getAsync(attachment.parentID)) as Zotero.Item)
    : undefined;

  return {
    attachmentID: attachment.id,
    attachmentKey: attachment.key,
    itemTitle:
      (parentItem?.getField("title", false, true) as string) ||
      (attachment.getField("title", false, true) as string) ||
      attachment.key,
  };
}

function getReaderCurrentPageNumber(reader: any): number | undefined {
  const currentPageNumber = Number(
    reader?._iframeWindow?.wrappedJSObject?.PDFViewerApplication?.pdfViewer
      ?.currentPageNumber ??
      reader?._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber,
  );

  return Number.isFinite(currentPageNumber) ? currentPageNumber : undefined;
}

function getReaderPdfDocument(reader: any): any {
  return (
    reader?._iframeWindow?.wrappedJSObject?.PDFViewerApplication?.pdfDocument ??
    reader?._iframeWindow?.PDFViewerApplication?.pdfDocument
  );
}

async function getPdfPageTextEntries(
  reader: any,
  pdfDocument: any,
  pageNumber: number,
): Promise<PageTextEntry[]> {
  const directEntries = await getPdfPageTextEntriesDirect(pdfDocument, pageNumber);
  if (directEntries.length) {
    return directEntries;
  }

  return getPdfPageTextEntriesFromContentWindow(reader, pageNumber);
}

async function getPdfPageTextEntriesDirect(
  pdfDocument: any,
  pageNumber: number,
): Promise<PageTextEntry[]> {
  const pdfPage = await pdfDocument.getPage(pageNumber);
  const textContent = await pdfPage?.getTextContent?.();
  return mapPdfTextItemsToEntries(textContent?.items);
}

async function getPdfPageTextEntriesFromContentWindow(
  reader: any,
  pageNumber: number,
): Promise<PageTextEntry[]> {
  const iframeWindow = reader?._iframeWindow?.wrappedJSObject ?? reader?._iframeWindow;
  const runner = iframeWindow?.Function?.(
    `return (async function(pageNumber) {
      const app = this.PDFViewerApplication;
      const pdfDocument = app?.pdfDocument;
      if (!pdfDocument?.getPage) {
        return "[]";
      }

      const pdfPage = await pdfDocument.getPage(pageNumber);
      const textContent = await pdfPage.getTextContent();
      const entries = Array.from(textContent?.items ?? [])
        .map((item) => {
          const text = typeof item?.str === "string"
            ? item.str.replace(/\u00a0/g, " ").trim()
            : "";
          if (!text) {
            return undefined;
          }

          const transform = Array.from(item?.transform ?? [])
            .slice(0, 6)
            .map((value) => Number(value));
          if (
            transform.length !== 6 ||
            transform.some((value) => !Number.isFinite(value))
          ) {
            return undefined;
          }

          const width = Math.max(Math.abs(Number(item?.width) || 0), 1);
          const height = Math.max(
            Math.abs(Number(item?.height) || 0),
            Math.abs(transform[3]) || Math.abs(transform[0]) || 0,
            1,
          );
          const left = transform[4];
          const bottom = transform[5];
          const right = left + width;
          const top = bottom - height;

          return {
            text,
            left,
            top,
            right,
            bottom,
            centerX: (left + right) / 2,
            centerY: (top + bottom) / 2,
          };
        })
        .filter(Boolean);

      return JSON.stringify(entries);
    }).apply(this, arguments);`,
  );
  if (!runner) {
    return [];
  }

  const serializedEntries = await runner.call(iframeWindow, pageNumber);
  if (typeof serializedEntries !== "string" || !serializedEntries) {
    return [];
  }

  try {
    return normalizeSerializedPageEntries(JSON.parse(serializedEntries));
  } catch {
    return [];
  }
}

function mapPdfTextItemsToEntries(items: unknown): PageTextEntry[] {
  return Array.from((items ?? []) as ArrayLike<any>)
    .map((item) => buildPageTextEntry(item))
    .filter((entry): entry is PageTextEntry => Boolean(entry));
}

function normalizeSerializedPageEntries(entries: unknown): PageTextEntry[] {
  return Array.from((entries ?? []) as ArrayLike<any>)
    .map((entry) => buildPageTextEntry(entry, true))
    .filter((pageEntry): pageEntry is PageTextEntry => Boolean(pageEntry));
}

function buildPageTextEntry(
  item: any,
  hasExplicitBounds = false,
): PageTextEntry | undefined {
  const text =
    typeof item?.text === "string"
      ? item.text.trim()
      : typeof item?.str === "string"
        ? item.str.replace(/\u00a0/g, " ").trim()
        : "";
  if (!text) {
    return undefined;
  }

  if (hasExplicitBounds) {
    const left = Number(item?.left);
    const top = Number(item?.top);
    const right = Number(item?.right);
    const bottom = Number(item?.bottom);
    const centerX = Number(item?.centerX);
    const centerY = Number(item?.centerY);

    if (
      ![
        left,
        top,
        right,
        bottom,
        centerX,
        centerY,
      ].every((value) => Number.isFinite(value))
    ) {
      return undefined;
    }

    return {
      text,
      left,
      top,
      right,
      bottom,
      centerX,
      centerY,
    };
  }

  const transform = snapshotNumericTuple(item?.transform, 6);
  if (!transform) {
    return undefined;
  }

  const width = Math.max(Math.abs(Number(item?.width) || 0), 1);
  const height = Math.max(
    Math.abs(Number(item?.height) || 0),
    Math.abs(transform[3]) || Math.abs(transform[0]) || 0,
    1,
  );
  const left = transform[4];
  const bottom = transform[5];
  const right = left + width;
  const top = bottom - height;

  return {
    text,
    left,
    top,
    right,
    bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

function buildTableRows(entries: PageTextEntry[]): TableLikeRow[] {
  if (!entries.length) {
    return [];
  }

  const sortedEntries = [...entries].sort((left, right) => {
    const verticalDistance = right.centerY - left.centerY;
    if (Math.abs(verticalDistance) > 0.5) {
      return verticalDistance;
    }
    return left.left - right.left;
  });
  const entryHeights = sortedEntries.map((entry) => entry.bottom - entry.top);
  const rowTolerance = Math.max(6, getMedian(entryHeights) * 0.8);
  const rows: Array<{
    entries: PageTextEntry[];
    left: number;
    top: number;
    right: number;
    bottom: number;
    centerY: number;
  }> = [];

  for (const entry of sortedEntries) {
    const lastRow = rows.at(-1);
    if (!lastRow || Math.abs(entry.centerY - lastRow.centerY) > rowTolerance) {
      rows.push({
        entries: [entry],
        left: entry.left,
        top: entry.top,
        right: entry.right,
        bottom: entry.bottom,
        centerY: entry.centerY,
      });
      continue;
    }

    lastRow.entries.push(entry);
    lastRow.left = Math.min(lastRow.left, entry.left);
    lastRow.top = Math.min(lastRow.top, entry.top);
    lastRow.right = Math.max(lastRow.right, entry.right);
    lastRow.bottom = Math.max(lastRow.bottom, entry.bottom);
    lastRow.centerY = getMedian(lastRow.entries.map((rowEntry) => rowEntry.centerY));
  }

  return rows
    .map((row) => {
      const cells = buildCellsFromEntries(
        [...row.entries].sort((left, right) => left.left - right.left),
      );
      if (!cells.length) {
        return undefined;
      }

      return {
        left: row.left,
        top: row.top,
        right: row.right,
        bottom: row.bottom,
        centerY: row.centerY,
        cells,
      } satisfies TableLikeRow;
    })
    .filter((row): row is TableLikeRow => Boolean(row));
}

function collectTableRowBlocks(rows: TableLikeRow[]): TableLikeRow[][] {
  if (!rows.length) {
    return [];
  }

  const rowHeights = rows.map((row) => row.bottom - row.top);
  const rowGapTolerance = Math.max(18, getMedian(rowHeights) * 2.4);
  const rowBlocks: TableLikeRow[][] = [];
  let currentBlock: TableLikeRow[] = [];

  const flushBlock = () => {
    if (currentBlock.length >= MIN_TABLE_ROWS) {
      rowBlocks.push([...currentBlock]);
    }
    currentBlock = [];
  };

  for (const row of rows) {
    if (row.cells.length < MIN_TABLE_COLUMNS) {
      flushBlock();
      continue;
    }

    const lastRow = currentBlock.at(-1);
    if (!lastRow) {
      currentBlock = [row];
      continue;
    }

    const gap = Math.abs(lastRow.centerY - row.centerY);
    if (gap > rowGapTolerance || !rowsLookCompatible(lastRow, row)) {
      flushBlock();
      currentBlock = [row];
      continue;
    }

    currentBlock.push(row);
  }

  flushBlock();
  return rowBlocks;
}

function collectTableCaptionAnchors(rows: TableLikeRow[]): TableCaptionAnchor[] {
  return rows.flatMap((row) =>
    row.cells.flatMap((cell) => {
      const captionText = cell.text.replace(/\s+/g, " ").trim();
      if (!TABLE_CAPTION_PATTERN.test(captionText)) {
        return [];
      }

      return [
        {
          text: captionText,
          left: cell.left,
          top: cell.top,
          right: cell.right,
          bottom: cell.bottom,
          centerY: row.centerY,
        } satisfies TableCaptionAnchor,
      ];
    }),
  );
}

function matchCaptionAnchorsToRowBlocks(
  captionAnchors: TableCaptionAnchor[],
  rowBlocks: TableLikeRow[][],
): Array<{ rowBlock: TableLikeRow[]; caption: TableCaptionAnchor }> {
  if (!captionAnchors.length || !rowBlocks.length) {
    return [];
  }

  const usedBlocks = new Set<number>();

  return captionAnchors.flatMap((caption, captionIndex) => {
    const nextCaption = captionAnchors[captionIndex + 1];
    const matchedBlockIndex = rowBlocks.findIndex((rowBlock, rowBlockIndex) => {
      if (usedBlocks.has(rowBlockIndex)) {
        return false;
      }

      return isRowBlockAnchoredByCaption(rowBlock, caption, nextCaption);
    });

    if (matchedBlockIndex < 0) {
      return [];
    }

    usedBlocks.add(matchedBlockIndex);
    return [{ rowBlock: rowBlocks[matchedBlockIndex], caption }];
  });
}

function isRowBlockAnchoredByCaption(
  rowBlock: TableLikeRow[],
  caption: TableCaptionAnchor,
  nextCaption?: TableCaptionAnchor,
): boolean {
  const firstRow = rowBlock[0];
  if (!firstRow) {
    return false;
  }

  const blockLeft = Math.min(...rowBlock.map((row) => row.left));
  const blockRight = Math.max(...rowBlock.map((row) => row.right));
  const blockTopRow = Math.max(...rowBlock.map((row) => row.bottom));
  const verticalGap = caption.top - blockTopRow;
  const maxVerticalGap = Math.max(72, (caption.bottom - caption.top) * 12);

  if (verticalGap < -6 || verticalGap > maxVerticalGap) {
    return false;
  }

  if (!rangesOverlap(caption.left, caption.right, blockLeft, blockRight, 24)) {
    return false;
  }

  if (
    nextCaption &&
    rangesOverlap(caption.left, caption.right, nextCaption.left, nextCaption.right, 24) &&
    firstRow.centerY <= nextCaption.centerY
  ) {
    return false;
  }

  return true;
}

function clipRowBlockToCaptionLane(
  rowBlock: TableLikeRow[],
  caption: TableCaptionAnchor,
): TableLikeRow[] {
  if (!rowBlock.length) {
    return [];
  }

  const blockLeft = Math.min(...rowBlock.map((row) => row.left));
  const blockRight = Math.max(...rowBlock.map((row) => row.right));
  const blockMidpoint = (blockLeft + blockRight) / 2;
  const captionMode =
    caption.left > blockMidpoint
      ? "right"
      : caption.right < blockMidpoint
        ? "left"
        : "overlap";

  return rowBlock
    .map((row) => {
      const cellClusters = splitCellsIntoHorizontalClusters(row.cells);
      const selectedCluster = selectClusterForCaption(
        cellClusters,
        caption,
        captionMode,
      );
      const cells = selectedCluster ?? row.cells;

      if (!cells.length) {
        return undefined;
      }

      return {
        left: Math.min(...cells.map((cell) => cell.left)),
        top: Math.min(...cells.map((cell) => cell.top)),
        right: Math.max(...cells.map((cell) => cell.right)),
        bottom: Math.max(...cells.map((cell) => cell.bottom)),
        centerY: row.centerY,
        cells,
      } satisfies TableLikeRow;
    })
    .filter((row): row is TableLikeRow => Boolean(row));
}

function splitCellsIntoHorizontalClusters(
  cells: StructuredCell[],
): StructuredCell[][] {
  if (!cells.length) {
    return [];
  }

  const sortedCells = [...cells].sort((left, right) => left.left - right.left);
  const positiveGaps = sortedCells
    .slice(1)
    .map((cell, index) => cell.left - sortedCells[index].right)
    .filter((gap) => gap > 0);
  const gapThreshold = positiveGaps.length
    ? Math.max(36, getMedian(positiveGaps) * 2.5)
    : Number.POSITIVE_INFINITY;
  const clusters: StructuredCell[][] = [];
  let currentCluster: StructuredCell[] = [];

  for (const cell of sortedCells) {
    const lastCell = currentCluster.at(-1);
    if (!lastCell || cell.left - lastCell.right <= gapThreshold) {
      currentCluster.push(cell);
      continue;
    }

    clusters.push(currentCluster);
    currentCluster = [cell];
  }

  if (currentCluster.length) {
    clusters.push(currentCluster);
  }

  return clusters;
}

function selectClusterForCaption(
  cellClusters: StructuredCell[][],
  caption: TableCaptionAnchor,
  captionMode: "left" | "right" | "overlap",
): StructuredCell[] | undefined {
  if (!cellClusters.length) {
    return undefined;
  }

  if (cellClusters.length === 1) {
    return cellClusters[0];
  }

  if (captionMode === "right") {
    return [...cellClusters]
      .reverse()
      .find(
        (cluster) =>
          (cluster.at(-1)?.right ?? Number.NEGATIVE_INFINITY) >= caption.left - 24,
      );
  }

  if (captionMode === "left") {
    return cellClusters.find(
      (cluster) => (cluster[0]?.left ?? Number.POSITIVE_INFINITY) <= caption.right + 24,
    );
  }

  return cellClusters.reduce<StructuredCell[] | undefined>((bestCluster, cluster) => {
    const clusterLeft = Math.min(...cluster.map((cell) => cell.left));
    const clusterRight = Math.max(...cluster.map((cell) => cell.right));
    const clusterOverlap = Math.max(
      0,
      Math.min(clusterRight, caption.right) - Math.max(clusterLeft, caption.left),
    );
    if (!bestCluster) {
      return cluster;
    }

    const bestLeft = Math.min(...bestCluster.map((cell) => cell.left));
    const bestRight = Math.max(...bestCluster.map((cell) => cell.right));
    const bestOverlap = Math.max(
      0,
      Math.min(bestRight, caption.right) - Math.max(bestLeft, caption.left),
    );
    return clusterOverlap > bestOverlap ? cluster : bestCluster;
  }, undefined);
}

function rowsLookCompatible(left: TableLikeRow, right: TableLikeRow): boolean {
  if (!left.cells.length || !right.cells.length) {
    return false;
  }

  const leftStart = left.cells[0].left;
  const leftEnd = left.cells.at(-1)?.right ?? left.right;
  const rightStart = right.cells[0].left;
  const rightEnd = right.cells.at(-1)?.right ?? right.right;

  return (
    Math.abs(left.cells.length - right.cells.length) <= 2 &&
    leftEnd >= rightStart - 24 &&
    rightEnd >= leftStart - 24
  );
}

function getRowText(row: TableLikeRow): string {
  return row.cells
    .map((cell) => cell.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  tolerance = 0,
): boolean {
  return leftEnd >= rightStart - tolerance && rightEnd >= leftStart - tolerance;
}

function normalizeDetectedTableRows(rows: TableLikeRow[]): string[][] {
  if (rows.length < MIN_TABLE_ROWS) {
    return [];
  }

  const columnCount = Math.max(...rows.map((row) => row.cells.length));
  if (columnCount < MIN_TABLE_COLUMNS) {
    return [];
  }

  const templateRow = rows.find((row) => row.cells.length === columnCount) ?? rows[0];
  const anchors = templateRow.cells.map((cell) => cell.centerX);
  const structuredRows = rows
    .map((row) =>
      alignCellsToAnchors(row.cells, anchors, columnCount).map((cell) =>
        cell.trim(),
      ),
    )
    .filter((row) => row.some((cell) => cell.length));
  const populatedRows = structuredRows.filter(
    (row) => row.filter((cell) => cell.length).length >= MIN_TABLE_COLUMNS,
  );

  return populatedRows.length >= MIN_TABLE_ROWS ? structuredRows : [];
}

function getSelectionAnnotation(
  reader: any,
): SelectionAnnotationSnapshot | undefined {
  const annotation =
    reader?._internalReader?._lastView?._selectionPopup?.annotation;
  return snapshotSelectionAnnotation(annotation);
}

function snapshotSelectionAnnotation(
  annotation?: _ZoteroTypes.Annotations.AnnotationJson,
): SelectionAnnotationSnapshot | undefined {
  const pageIndex = Number(annotation?.position?.pageIndex);
  const rects = Array.from(
    (annotation?.position?.rects ?? []) as ArrayLike<unknown>,
  )
    .map((rawRect) => snapshotNumericTuple(rawRect, 4))
    .filter((rect): rect is number[] => Boolean(rect));

  if (!rects.length || !Number.isFinite(pageIndex)) {
    return undefined;
  }

  return {
    text: typeof annotation?.text === "string" ? annotation.text : undefined,
    position: {
      pageIndex,
      rects,
    },
  };
}

function getSelectedText(
  reader: any,
  selectionAnnotation?: SelectionAnnotationSnapshot,
): string {
  const domSelectionText =
    reader?._iframeWindow?.getSelection?.()?.toString?.() ?? "";
  if (domSelectionText.trim()) {
    return domSelectionText;
  }

  try {
    const annotationText = ztoolkit.Reader.getSelectedText(reader) || "";
    if (annotationText.trim()) {
      return annotationText;
    }
  } catch {
    // Fall back to the raw selection annotation text below.
  }

  return selectionAnnotation?.text ?? "";
}

async function extractStructuredSelection(
  reader: any,
  selectionAnnotation?: SelectionAnnotationSnapshot,
): Promise<StructuredSelectionResult> {
  const diagnostics: string[] = [];
  const rects = selectionAnnotation?.position?.rects;
  if (!rects?.length) {
    return { rows: [], diagnostics };
  }

  const annotation = selectionAnnotation as SelectionAnnotationSnapshot;

  const pdfViewer =
    reader?._iframeWindow?.wrappedJSObject?.PDFViewerApplication?.pdfViewer ??
    reader?._iframeWindow?.PDFViewerApplication?.pdfViewer;
  const pageView = pdfViewer?.getPageView?.(annotation.position.pageIndex);
  if (!pageView?.div || !pageView.viewport) {
    diagnostics.push(getString("reader-diagnostic-page-view-unavailable"));
    return {
      rows: [],
      diagnostics,
      selectionRectCount: rects.length,
    };
  }

  const textLayerDiv =
    pageView.textLayer?.div ??
    (pageView.div.querySelector(".textLayer") as HTMLDivElement | null);
  if (!textLayerDiv) {
    diagnostics.push(getString("reader-diagnostic-text-layer-unavailable"));
    return {
      rows: [],
      diagnostics,
      selectionRectCount: rects.length,
    };
  }

  const viewportTransform = snapshotNumericTuple(
    pageView.viewport.transform,
    6,
  );
  if (!viewportTransform) {
    diagnostics.push(getString("reader-diagnostic-viewport-unavailable"));
    return {
      rows: [],
      diagnostics,
      selectionRectCount: rects.length,
    };
  }

  const pageBounds = pageView.div.getBoundingClientRect();
  const selectionRects = rects
    .map((rect) => convertPdfRectToViewportRect(viewportTransform, rect))
    .map((rect) => toLocalRect(rect));
  const spanElements = Array.from(
    textLayerDiv.querySelectorAll("span"),
  ) as HTMLSpanElement[];
  const selectionEntries = spanElements
    .map((span) => {
      const text = span.textContent?.replace(/\u00a0/g, " ").trim();
      if (!text) {
        return undefined;
      }

      const bounds = span.getBoundingClientRect();
      if (!bounds.width || !bounds.height) {
        return undefined;
      }

      const entry = {
        text,
        left: bounds.left - pageBounds.left,
        top: bounds.top - pageBounds.top,
        right: bounds.right - pageBounds.left,
        bottom: bounds.bottom - pageBounds.top,
        centerX: bounds.left - pageBounds.left + bounds.width / 2,
        centerY: bounds.top - pageBounds.top + bounds.height / 2,
      } satisfies SelectionTextEntry;
      return intersectsAny(entry, selectionRects) ? entry : undefined;
    })
    .filter((entry): entry is SelectionTextEntry => Boolean(entry));

  if (!selectionEntries.length) {
    diagnostics.push(getString("reader-diagnostic-no-text-spans"));
    return {
      rows: [],
      diagnostics,
      selectionRectCount: rects.length,
    };
  }

  const structuredRows = inferStructuredRows(selectionRects, selectionEntries);
  if (!structuredRows.length) {
    diagnostics.push(getString("reader-diagnostic-grid-fallback"));
    return {
      rows: [],
      diagnostics,
      selectionRectCount: rects.length,
    };
  }

  diagnostics.push(
    getString("reader-diagnostic-geometry-rows", {
      args: {
        rows: structuredRows.length,
        rects: rects.length,
      },
    }),
  );
  diagnostics.push(
    getString("reader-diagnostic-geometry-columns", {
      args: {
        cols: Math.max(...structuredRows.map((row) => row.length)),
      },
    }),
  );

  return {
    rows: structuredRows,
    diagnostics,
    selectionRectCount: rects.length,
  };
}

function inferStructuredRows(
  selectionRects: LocalRect[],
  entries: SelectionTextEntry[],
): string[][] {
  const rowBands = buildRowBands(selectionRects);
  if (!rowBands.length) {
    return [];
  }

  const rowCells = rowBands
    .map((rowBand) => {
      const rowEntries = entries
        .filter((entry) => intersectsVertically(entry, rowBand))
        .sort((left, right) => left.left - right.left);
      return buildCellsFromEntries(rowEntries);
    })
    .filter((cells) => cells.length);

  if (!rowCells.length) {
    return [];
  }

  const columnCount = Math.max(...rowCells.map((cells) => cells.length));
  if (rowCells.length < 2 && columnCount < 2) {
    return [];
  }

  const templateRow =
    rowCells.find((cells) => cells.length === columnCount) ?? rowCells[0];
  const anchors = templateRow.map((cell) => cell.centerX);

  return rowCells.map((cells) =>
    alignCellsToAnchors(cells, anchors, columnCount),
  );
}

function buildRowBands(selectionRects: LocalRect[]): LocalRect[] {
  const sortedRects = [...selectionRects].sort(
    (left, right) => rectCenterY(left) - rectCenterY(right),
  );
  const heights = sortedRects.map((rect) => rect.bottom - rect.top);
  const tolerance = Math.max(6, getMedian(heights) * 0.75);
  const rowBands: LocalRect[] = [];

  for (const rect of sortedRects) {
    const lastBand = rowBands.at(-1);
    if (
      !lastBand ||
      Math.abs(rectCenterY(rect) - rectCenterY(lastBand)) > tolerance
    ) {
      rowBands.push({ ...rect });
      continue;
    }

    lastBand.left = Math.min(lastBand.left, rect.left);
    lastBand.top = Math.min(lastBand.top, rect.top);
    lastBand.right = Math.max(lastBand.right, rect.right);
    lastBand.bottom = Math.max(lastBand.bottom, rect.bottom);
  }

  return rowBands;
}

function buildCellsFromEntries(
  entries: SelectionTextEntry[],
): StructuredCell[] {
  if (!entries.length) {
    return [];
  }

  const gapTolerance = getCellGapTolerance(entries);
  const cells: StructuredCell[] = [];

  for (const entry of entries) {
    const lastCell = cells.at(-1);
    if (!lastCell || entry.left - lastCell.right >= gapTolerance) {
      cells.push({
        left: entry.left,
        top: entry.top,
        right: entry.right,
        bottom: entry.bottom,
        centerX: entry.centerX,
        text: entry.text,
      });
      continue;
    }

    lastCell.right = Math.max(lastCell.right, entry.right);
    lastCell.bottom = Math.max(lastCell.bottom, entry.bottom);
    lastCell.top = Math.min(lastCell.top, entry.top);
    lastCell.text = `${lastCell.text} ${entry.text}`
      .replace(/\s+/g, " ")
      .trim();
    lastCell.centerX = (lastCell.left + lastCell.right) / 2;
  }

  return cells;
}

function getCellGapTolerance(entries: SelectionTextEntry[]): number {
  const entryHeights = entries.map((entry) => entry.bottom - entry.top);
  const heightDrivenLimit = Math.max(2, getMedian(entryHeights) * 0.4);
  const horizontalGaps = entries
    .slice(1)
    .map((entry, index) => entry.left - entries[index].right)
    .filter((gap) => Number.isFinite(gap) && gap > 0);

  if (!horizontalGaps.length) {
    return Math.min(6, heightDrivenLimit);
  }

  const gapDrivenLimit = Math.max(2, getMedian(horizontalGaps) * 0.6);
  return Math.min(6, heightDrivenLimit, gapDrivenLimit);
}

function alignCellsToAnchors(
  cells: StructuredCell[],
  anchors: number[],
  columnCount: number,
): string[] {
  if (cells.length === columnCount) {
    return cells.map((cell) => cell.text);
  }

  const alignedCells = Array.from({ length: columnCount }, () => "");
  let nextAnchorIndex = 0;

  for (const cell of cells) {
    let bestAnchorIndex = nextAnchorIndex;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = nextAnchorIndex; index < anchors.length; index += 1) {
      const distance = Math.abs(cell.centerX - anchors[index]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestAnchorIndex = index;
      }
    }

    alignedCells[bestAnchorIndex] = alignedCells[bestAnchorIndex]
      ? `${alignedCells[bestAnchorIndex]} ${cell.text}`
      : cell.text;
    nextAnchorIndex = Math.min(bestAnchorIndex + 1, anchors.length - 1);
  }

  return alignedCells;
}

function toLocalRect(rect: number[]): LocalRect {
  return {
    left: Math.min(rect[0], rect[2]),
    top: Math.min(rect[1], rect[3]),
    right: Math.max(rect[0], rect[2]),
    bottom: Math.max(rect[1], rect[3]),
  };
}

function snapshotNumericTuple(
  values: unknown,
  expectedLength: number,
): number[] | undefined {
  if (!values) {
    return undefined;
  }

  const tuple = Array.from(values as ArrayLike<unknown>)
    .slice(0, expectedLength)
    .map((value) => Number(value));
  if (
    tuple.length !== expectedLength ||
    tuple.some((value) => !Number.isFinite(value))
  ) {
    return undefined;
  }
  return tuple;
}

function convertPdfRectToViewportRect(
  transform: number[],
  rect: number[],
): number[] {
  const firstPoint = applyAffineTransform(transform, rect[0], rect[1]);
  const secondPoint = applyAffineTransform(transform, rect[2], rect[3]);
  return [firstPoint[0], firstPoint[1], secondPoint[0], secondPoint[1]];
}

function applyAffineTransform(
  transform: number[],
  x: number,
  y: number,
): [number, number] {
  return [
    transform[0] * x + transform[2] * y + transform[4],
    transform[1] * x + transform[3] * y + transform[5],
  ];
}

function rectCenterY(rect: LocalRect): number {
  return (rect.top + rect.bottom) / 2;
}

function intersectsAny(targetRect: LocalRect, rects: LocalRect[]): boolean {
  return rects.some((rect) => intersects(targetRect, rect));
}

function intersects(left: LocalRect, right: LocalRect): boolean {
  return !(
    left.right < right.left - 2 ||
    left.left > right.right + 2 ||
    left.bottom < right.top - 2 ||
    left.top > right.bottom + 2
  );
}

function intersectsVertically(left: LocalRect, right: LocalRect): boolean {
  return !(left.bottom < right.top - 2 || left.top > right.bottom + 2);
}

function getMedian(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2
    : sortedValues[middleIndex];
}
