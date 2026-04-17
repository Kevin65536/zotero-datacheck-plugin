import type { ReaderAuditContext, TableSelectionDraft } from "./types";

interface LocalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface SelectionTextEntry extends LocalRect {
  text: string;
  centerX: number;
  centerY: number;
}

interface StructuredCell extends LocalRect {
  text: string;
  centerX: number;
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

export async function getActiveReaderContext(): Promise<ReaderAuditContext | null> {
  const tabs = ztoolkit.getGlobal("Zotero_Tabs") as any;
  const selectedTabID = tabs?.selectedID;
  if (!selectedTabID) {
    return null;
  }

  const reader = Zotero.Reader.getByTabID(selectedTabID) as any;
  if (!reader?.itemID) {
    return null;
  }

  const attachment = (await Zotero.Items.getAsync(reader.itemID)) as Zotero.Item;
  const parentItem = attachment.parentID
    ? ((await Zotero.Items.getAsync(attachment.parentID)) as Zotero.Item)
    : undefined;

  const rememberedSelection =
    rememberedReaderSelection?.tabID === selectedTabID
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
    (rememberedSelection?.annotation || rememberedSelection?.selectedText.trim())
  ) {
    structuredSelection.diagnostics.unshift(
      "Used the preserved reader selection because the live selection was cleared when the command opened.",
    );
  }

  let selectedText = getSelectedText(reader, selectionAnnotation);
  if (!selectedText.trim() && rememberedSelection?.selectedText.trim()) {
    selectedText = rememberedSelection.selectedText;
  }
  if (structuredSelection.rows.length) {
    selectedText = structuredSelection.rows.map((row) => row.join("\t")).join("\n");
  }

  const currentPageNumber = Number(
    reader?._iframeWindow?.wrappedJSObject?.PDFViewerApplication?.pdfViewer
      ?.currentPageNumber,
  );

  return {
    attachmentID: attachment.id,
    attachmentKey: attachment.key,
    itemTitle:
      (parentItem?.getField("title", false, true) as string) ||
      (attachment.getField("title", false, true) as string) ||
      attachment.key,
    pageNumber: Number.isFinite(currentPageNumber)
      ? currentPageNumber
      : undefined,
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

function getSelectionAnnotation(
  reader: any,
): SelectionAnnotationSnapshot | undefined {
  const annotation = reader?._internalReader?._lastView?._selectionPopup?.annotation;
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
  const domSelectionText = reader?._iframeWindow?.getSelection?.()?.toString?.() ?? "";
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
    diagnostics.push(
      "Selection geometry is available, but the current PDF page view is not ready.",
    );
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
    diagnostics.push(
      "Selection geometry is available, but the PDF text layer is not available.",
    );
    return {
      rows: [],
      diagnostics,
      selectionRectCount: rects.length,
    };
  }

  const viewportTransform = snapshotNumericTuple(pageView.viewport.transform, 6);
  if (!viewportTransform) {
    diagnostics.push(
      "Selection geometry is available, but the PDF viewport transform is not available.",
    );
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
    diagnostics.push(
      "Selection geometry is available, but no matching text-layer spans were found.",
    );
    return {
      rows: [],
      diagnostics,
      selectionRectCount: rects.length,
    };
  }

  const structuredRows = inferStructuredRows(selectionRects, selectionEntries);
  if (!structuredRows.length) {
    diagnostics.push(
      "Selection geometry did not produce a stable row/column grid, so DataCheck fell back to plain-text parsing.",
    );
    return {
      rows: [],
      diagnostics,
      selectionRectCount: rects.length,
    };
  }

  diagnostics.push(
    `Geometry extracted ${structuredRows.length} visual row(s) from ${rects.length} selection rectangle(s).`,
  );
  diagnostics.push(
    `Structured extraction reconstructed up to ${Math.max(...structuredRows.map((row) => row.length))} column(s) from the PDF text layer.`,
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

  const templateRow = rowCells.find((cells) => cells.length === columnCount) ?? rowCells[0];
  const anchors = templateRow.map((cell) => cell.centerX);

  return rowCells.map((cells) => alignCellsToAnchors(cells, anchors, columnCount));
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
    if (!lastBand || Math.abs(rectCenterY(rect) - rectCenterY(lastBand)) > tolerance) {
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

function buildCellsFromEntries(entries: SelectionTextEntry[]): StructuredCell[] {
  if (!entries.length) {
    return [];
  }

  const entryHeights = entries.map((entry) => entry.bottom - entry.top);
  const gapTolerance = Math.max(12, getMedian(entryHeights) * 0.9);
  const cells: StructuredCell[] = [];

  for (const entry of entries) {
    const lastCell = cells.at(-1);
    if (!lastCell || entry.left - lastCell.right > gapTolerance) {
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
    lastCell.text = `${lastCell.text} ${entry.text}`.replace(/\s+/g, " ").trim();
    lastCell.centerX = (lastCell.left + lastCell.right) / 2;
  }

  return cells;
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