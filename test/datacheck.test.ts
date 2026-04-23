import { assert } from "chai";
import { buildAuditReport } from "../src/modules/datacheck/audit";
import type { AuditDetectorId } from "../src/modules/datacheck/detectors";
import {
  appendSelectionPopupAnalyzeButton,
  buildReportVisualizationModel,
  renderSelectionPopupAnalyzeAction,
} from "../src/modules/datacheck/commands";
import {
  debugScanActiveReaderForTables,
  detectTableDraftsFromPageEntries,
  scanActiveReaderForTables,
} from "../src/modules/datacheck/reader";
import {
  parseNumericValue,
  parseTableSelection,
} from "../src/modules/datacheck/parser";
import type {
  PageTextEntry,
  TableSelectionDraft,
} from "../src/modules/datacheck/types";

const REAL_PDF_TITLE_QUERY = readTestEnv("ZOTERO_PLUGIN_TEST_PDF_TITLE_QUERY");
const REAL_PDF_MIN_TABLES = readPositiveIntEnv(
  "ZOTERO_PLUGIN_TEST_PDF_MIN_TABLES",
  1,
);
const REAL_PDF_MIN_COLUMNS = readPositiveIntEnv(
  "ZOTERO_PLUGIN_TEST_PDF_MIN_COLUMNS",
  4,
);

function createDraft(
  selectedText: string,
  overrides: Partial<TableSelectionDraft> = {},
): TableSelectionDraft {
  return {
    source: "reader-text-selection",
    attachmentID: 1,
    attachmentKey: "ABCD1234",
    itemTitle: "Synthetic table",
    pageNumber: 3,
    selectedText,
    selectedTextLength: selectedText.length,
    capturedAt: "2026-04-17T09:00:00.000Z",
    ...overrides,
  };
}

function createPageEntry(
  text: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
): PageTextEntry {
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

function readTestEnv(name: string): string | undefined {
  const nodeValue =
    typeof process !== "undefined" ? process?.env?.[name]?.trim() : undefined;
  if (nodeValue) {
    return nodeValue;
  }

  const geckoValue = (globalThis as any).Services?.env?.get?.(name);
  return typeof geckoValue === "string" && geckoValue.trim()
    ? geckoValue.trim()
    : undefined;
}

function readPositiveIntEnv(name: string, fallbackValue: number): number {
  const rawValue = readTestEnv(name);
  const parsedValue = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallbackValue;
}

function formatPreviewRow(row: string[] | undefined): string {
  if (!row?.length) {
    return "<empty>";
  }

  return row
    .map((cell) => cell.trim())
    .slice(0, 8)
    .join(" | ");
}

function describeDraft(draft: TableSelectionDraft, index: number): string {
  const rowCount = draft.structuredRows?.length ?? 0;
  const columnCount = Math.max(
    ...(draft.structuredRows?.map((row) => row.length) ?? [0]),
  );
  const preview = formatPreviewRow(draft.structuredRows?.[0]);
  const diagnostics =
    (draft.extractionDiagnostics ?? []).join(" || ") || "<none>";

  return [
    `  [table ${index + 1}] page=${draft.pageNumber ?? "?"} rows=${rowCount} cols=${columnCount}`,
    `    preview=${preview}`,
    `    diagnostics=${diagnostics}`,
  ].join("\n");
}

function formatDebugSummary(
  debugResult: NonNullable<
    Awaited<ReturnType<typeof debugScanActiveReaderForTables>>
  >,
): string {
  const zeroEntryPages = debugResult.pages.filter(
    (page) => page.entryCount === 0,
  ).length;
  const pageLines = debugResult.pages
    .slice(0, 12)
    .map((page) => {
      const blockPreview = page.blockSummaries.length
        ? page.blockSummaries
            .map(
              (block, index) =>
                `#${index + 1}:${block.rowCount}r/${block.maxColumnCount}c:${block.preview}`,
            )
            .join(" || ")
        : "<none>";
      return `  [page ${page.pageNumber}] entries=${page.entryCount} rows=${page.rowCount} rowBlocks=${page.rowBlockCount} detectedTables=${page.detectedTableCount} maxCells=${page.maxCellsInRow} maxDetectedCols=${page.maxDetectedColumnCount}\n    preview=${page.textPreview || "<empty>"}\n    blocks=${blockPreview}`;
    })
    .join("\n");

  return [
    `debug.pages=${debugResult.pageCount}`,
    `debug.diagnostics=${debugResult.diagnostics.join(" || ") || "<none>"}`,
    `debug.zeroEntryPages=${zeroEntryPages}`,
    pageLines || "  <no page summaries>",
  ].join("\n");
}

async function inspectReaderTextAccess(
  reader: any,
  pageNumber: number,
): Promise<string> {
  try {
    const pdfDocument = getReaderPdfDocumentForTest(reader);
    if (!pdfDocument?.getPage) {
      return `raw.page=${pageNumber} direct=<no-pdfDocument>`;
    }

    const pdfPage = await pdfDocument.getPage(pageNumber);
    const directTextContent = await pdfPage?.getTextContent?.();
    const directItems = Array.from(
      ((directTextContent as any)?.items ?? []) as ArrayLike<any>,
    );
    const directKeys = directTextContent
      ? Object.keys(directTextContent as Record<string, unknown>).join(",")
      : "<none>";
    const directStylesCount = directTextContent?.styles
      ? Object.keys(directTextContent.styles).length
      : 0;

    const iframeWindow =
      reader?._iframeWindow?.wrappedJSObject ?? reader?._iframeWindow;
    const pageView =
      iframeWindow?.PDFViewerApplication?.pdfViewer?.getPageView?.(
        pageNumber - 1,
      );
    const textLayerDiv =
      pageView?.textLayer?.div ??
      pageView?.div?.querySelector?.(".textLayer") ??
      null;
    const spanElements = textLayerDiv
      ? Array.from(textLayerDiv.querySelectorAll("span"))
      : [];
    const spanPreview = spanElements
      .map((element: any) => element?.textContent?.trim?.() ?? "")
      .filter(Boolean)
      .slice(0, 8)
      .join(" | ");

    let contentRealmSummary = "<unavailable>";
    try {
      const runner = iframeWindow?.Function?.(
        `return (async function(pageNumber) {
          const app = this.PDFViewerApplication;
          const pdfDocument = app?.pdfDocument;
          if (!pdfDocument?.getPage) {
            return { error: "no-pdfDocument" };
          }

          const pdfPage = await pdfDocument.getPage(pageNumber);
          const textContent = await pdfPage.getTextContent();
          const items = Array.from(textContent?.items ?? []);
          return {
            keys: textContent ? Object.keys(textContent) : [],
            itemsLength: items.length,
            firstStr: items[0]?.str ?? "",
            stylesCount: textContent?.styles ? Object.keys(textContent.styles).length : 0,
          };
        }).apply(this, arguments);`,
      );
      const realmResult = runner
        ? await runner.call(iframeWindow, pageNumber)
        : undefined;
      if (realmResult?.error) {
        contentRealmSummary = `error=${realmResult.error}`;
      } else if (realmResult) {
        contentRealmSummary = `items=${realmResult.itemsLength ?? "?"} first=${realmResult.firstStr || "<empty>"} keys=${(realmResult.keys ?? []).join(",")} styles=${realmResult.stylesCount ?? 0}`;
      }
    } catch (error) {
      contentRealmSummary = `error=${error instanceof Error ? error.message : String(error)}`;
    }

    return [
      `raw.page=${pageNumber}`,
      `direct.keys=${directKeys}`,
      `direct.items=${directItems.length}`,
      `direct.first=${directItems[0]?.str ?? "<empty>"}`,
      `direct.styles=${directStylesCount}`,
      `textLayer.spans=${spanElements.length}`,
      `textLayer.preview=${spanPreview || "<empty>"}`,
      `contentRealm.${contentRealmSummary}`,
    ].join("\n");
  } catch (error) {
    return `raw.page=${pageNumber} error=${error instanceof Error ? error.message : String(error)}`;
  }
}

function logRealPdfScanResult(params: {
  query: string;
  attachment: Zotero.Item;
  filePath: string | false;
  scanResult: NonNullable<
    Awaited<ReturnType<typeof scanActiveReaderForTables>>
  >;
  debugSummary: string;
  rawSummary: string;
}) {
  const { query, attachment, filePath, scanResult, debugSummary, rawSummary } =
    params;
  const draftDescriptions = scanResult.tableDrafts.length
    ? scanResult.tableDrafts
        .map((draft, index) => describeDraft(draft, index))
        .join("\n")
    : "  <no tables detected>";
  const diagnostics = scanResult.diagnostics.length
    ? scanResult.diagnostics.join(" || ")
    : "<none>";

  console.info(
    [
      `[real-pdf] query=${query}`,
      `[real-pdf] attachment=${attachment.getField("title", false, true)} (${attachment.key})`,
      `[real-pdf] item=${scanResult.itemTitle}`,
      `[real-pdf] path=${filePath || "<unavailable>"}`,
      `[real-pdf] pages=${scanResult.pageCount} tables=${scanResult.tableDrafts.length}`,
      `[real-pdf] diagnostics=${diagnostics}`,
      draftDescriptions,
      debugSummary,
      rawSummary,
    ].join("\n"),
  );
}

function getReaderPdfDocumentForTest(reader: any): any {
  return (
    reader?._iframeWindow?.wrappedJSObject?.PDFViewerApplication?.pdfDocument ??
    reader?._iframeWindow?.PDFViewerApplication?.pdfDocument
  );
}

async function waitForReaderPdfDocument(
  reader: any,
  timeoutMs = 30000,
  intervalMs = 250,
): Promise<any> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const pdfDocument = getReaderPdfDocumentForTest(reader);
    if (pdfDocument?.getPage && Number.isFinite(Number(pdfDocument.numPages))) {
      return pdfDocument;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return getReaderPdfDocumentForTest(reader);
}

async function findPdfAttachmentByQuery(
  query: string,
): Promise<Zotero.Item | undefined> {
  const loweredQuery = query.toLowerCase();
  const libraryID = Zotero.Libraries.userLibraryID;
  const items = await Zotero.Items.getAll(libraryID, false, false);
  const parentTitleCache = new Map<number, string>();

  for (const item of items) {
    if (!item.isPDFAttachment()) {
      continue;
    }

    const attachmentTitle = item.getField("title", false, true).toLowerCase();
    let parentTitle = "";

    if (item.parentID) {
      if (!parentTitleCache.has(item.parentID)) {
        const parentItem = (await Zotero.Items.getAsync(
          item.parentID,
        )) as Zotero.Item;
        parentTitleCache.set(
          item.parentID,
          parentItem.getField("title", false, true).toLowerCase(),
        );
      }

      parentTitle = parentTitleCache.get(item.parentID) ?? "";
    }

    if (
      attachmentTitle.includes(loweredQuery) ||
      parentTitle.includes(loweredQuery)
    ) {
      return item;
    }
  }

  return undefined;
}

describe("datacheck", function () {
  describe("datacheck parser", function () {
    it("parses tab-separated table text", function () {
      const table = parseTableSelection(
        createDraft("Group\tN\tRate\nControl\t10\t25%\nTreatment\t12\t30%"),
      );

      assert.equal(table.rowCount, 3);
      assert.equal(table.columnCount, 3);
      assert.deepEqual(table.header, ["Group", "N", "Rate"]);
      assert.equal(table.numericCellCount, 4);
      assert.lengthOf(table.reconstructionWarnings, 0);
    });

    it("parses p-values and percentages", function () {
      assert.deepEqual(parseNumericValue("p < 0.05"), {
        value: 0.05,
        kind: "p-value",
        comparator: "<",
        normalizedText: "p < 0.05",
      });
      assert.deepEqual(parseNumericValue("120%"), {
        value: 120,
        kind: "percentage",
        comparator: undefined,
        normalizedText: "120%",
      });
    });

    it("prefers structured rows when geometry reconstruction is available", function () {
      const table = parseTableSelection(
        createDraft("Group Alpha 10 20 Beta 30 40", {
          source: "reader-structured-selection",
          structuredRows: [
            ["Group", "Value A", "Value B"],
            ["Alpha", "10", "20"],
            ["Beta", "30", "40"],
          ],
          selectionRectCount: 6,
          extractionDiagnostics: ["structured-selection-ready"],
        }),
      );

      assert.equal(table.rowCount, 3);
      assert.equal(table.columnCount, 3);
      assert.deepEqual(table.header, ["Group", "Value A", "Value B"]);
      assert.equal(table.selectionRectCount, 6);
      assert.include(
        table.reconstructionWarnings,
        "structured-selection-ready",
      );
    });

    it("finds multiple table regions from full-page text geometry", function () {
      const pageEntries: PageTextEntry[] = [
        createPageEntry(
          "Table 1. Participant characteristics.",
          10,
          242,
          190,
          252,
        ),
        createPageEntry("Group", 10, 220, 50, 230),
        createPageEntry("N", 90, 220, 110, 230),
        createPageEntry("Rate", 150, 220, 190, 230),
        createPageEntry("Control", 10, 200, 60, 210),
        createPageEntry("10", 92, 200, 106, 210),
        createPageEntry("25%", 150, 200, 180, 210),
        createPageEntry("Treatment", 10, 180, 74, 190),
        createPageEntry("12", 92, 180, 106, 190),
        createPageEntry("30%", 150, 180, 180, 190),
        createPageEntry("Table 2. Follow-up outcomes.", 10, 142, 164, 152),
        createPageEntry("Visit", 10, 120, 46, 130),
        createPageEntry("p", 90, 120, 102, 130),
        createPageEntry("Result", 150, 120, 190, 130),
        createPageEntry("Week 1", 10, 100, 54, 110),
        createPageEntry("0.04", 90, 100, 118, 110),
        createPageEntry("Pass", 150, 100, 180, 110),
        createPageEntry("Week 2", 10, 80, 54, 90),
        createPageEntry("0.20", 90, 80, 118, 90),
        createPageEntry("Review", 150, 80, 192, 90),
      ];

      const drafts = detectTableDraftsFromPageEntries({
        attachmentID: 1,
        attachmentKey: "ABCD1234",
        itemTitle: "Synthetic page",
        pageNumber: 5,
        capturedAt: "2026-04-22T10:00:00.000Z",
        entries: pageEntries,
      });

      assert.lengthOf(drafts, 2);
      assert.equal(drafts[0].source, "reader-pdf-table-scan");
      assert.equal(drafts[0].pageNumber, 5);
      assert.deepEqual(drafts[0].structuredRows, [
        ["Group", "N", "Rate"],
        ["Control", "10", "25%"],
        ["Treatment", "12", "30%"],
      ]);
      assert.deepEqual(drafts[1].structuredRows, [
        ["Visit", "p", "Result"],
        ["Week 1", "0.04", "Pass"],
        ["Week 2", "0.20", "Review"],
      ]);
      assert.isAbove(drafts[0].selectedTextLength, 0);
      assert.include(
        drafts[1].extractionDiagnostics ?? [],
        "caption=Table 2. Follow-up outcomes.",
      );
    });

    it("ignores captionless multi-column blocks during full-page scans", function () {
      const pageEntries: PageTextEntry[] = [
        createPageEntry("Group", 10, 220, 50, 230),
        createPageEntry("N", 90, 220, 110, 230),
        createPageEntry("Rate", 150, 220, 190, 230),
        createPageEntry("Control", 10, 200, 60, 210),
        createPageEntry("10", 92, 200, 106, 210),
        createPageEntry("25%", 150, 200, 180, 210),
        createPageEntry("Treatment", 10, 180, 74, 190),
        createPageEntry("12", 92, 180, 106, 190),
        createPageEntry("30%", 150, 180, 180, 190),
      ];

      const drafts = detectTableDraftsFromPageEntries({
        attachmentID: 1,
        attachmentKey: "ABCD1234",
        itemTitle: "Captionless block",
        pageNumber: 5,
        capturedAt: "2026-04-22T10:00:00.000Z",
        entries: pageEntries,
      });

      assert.lengthOf(drafts, 0);
    });

    it("detects compact academic tables with narrow inter-column gaps", function () {
      const pageEntries: PageTextEntry[] = [
        createPageEntry(
          "Table 3. Evaluation on multimodal understanding benchmarks.",
          10,
          248,
          310,
          258,
        ),
        createPageEntry("Method", 10, 220, 38, 230),
        createPageEntry("Params", 44, 220, 68, 230),
        createPageEntry("Res.", 74, 220, 92, 230),
        createPageEntry("SEEDB", 98, 220, 124, 230),
        createPageEntry("MMV", 130, 220, 150, 230),
        createPageEntry("Avg.", 156, 220, 178, 230),
        createPageEntry("TokenFlow-B", 10, 202, 40, 212),
        createPageEntry("7B", 44, 202, 52, 212),
        createPageEntry("224", 74, 202, 88, 212),
        createPageEntry("60.4", 98, 202, 116, 212),
        createPageEntry("22.4", 130, 202, 148, 212),
        createPageEntry("55.2", 156, 202, 174, 212),
        createPageEntry("TokenFlow-XL", 10, 184, 40, 194),
        createPageEntry("14B", 44, 184, 56, 194),
        createPageEntry("384", 74, 184, 88, 194),
        createPageEntry("72.6", 98, 184, 116, 194),
        createPageEntry("48.2", 130, 184, 148, 194),
        createPageEntry("67.4", 156, 184, 174, 194),
        createPageEntry(
          "Our approach demonstrates superior performance while maintaining efficiency.",
          10,
          146,
          320,
          156,
        ),
      ];

      const drafts = detectTableDraftsFromPageEntries({
        attachmentID: 1,
        attachmentKey: "ABCD1234",
        itemTitle: "Compact academic table",
        pageNumber: 3,
        capturedAt: "2026-04-22T13:00:00.000Z",
        entries: pageEntries,
      });

      assert.lengthOf(drafts, 1);
      assert.deepEqual(drafts[0].structuredRows, [
        ["Method", "Params", "Res.", "SEEDB", "MMV", "Avg."],
        ["TokenFlow-B", "7B", "224", "60.4", "22.4", "55.2"],
        ["TokenFlow-XL", "14B", "384", "72.6", "48.2", "67.4"],
      ]);
    });

    it("can regression-test a configured real PDF through the reader pipeline", async function () {
      if (!REAL_PDF_TITLE_QUERY) {
        this.skip();
      }

      this.timeout(120000);

      const attachment = await findPdfAttachmentByQuery(REAL_PDF_TITLE_QUERY);
      assert.isOk(
        attachment,
        `No PDF attachment matched ZOTERO_PLUGIN_TEST_PDF_TITLE_QUERY=${REAL_PDF_TITLE_QUERY}`,
      );
      if (!attachment) {
        return;
      }

      let reader: any;
      try {
        reader = await Zotero.Reader.open(attachment.id, undefined, {
          allowDuplicate: true,
        });
        assert.isOk(
          reader,
          `Zotero.Reader.open did not return a reader for attachment ${attachment.key}`,
        );
        if (!reader) {
          return;
        }

        if (typeof reader._waitForReader === "function") {
          await reader._waitForReader();
        } else if (reader._initPromise) {
          await reader._initPromise;
        }

        const pdfDocument = await waitForReaderPdfDocument(reader);
        assert.isOk(
          pdfDocument?.getPage,
          `PDF document was not ready for attachment ${attachment.key} after waiting`,
        );

        const scanResult = await scanActiveReaderForTables(reader);
        assert.isOk(scanResult, "scanActiveReaderForTables returned null");
        if (!scanResult) {
          return;
        }
        const debugResult = await debugScanActiveReaderForTables(reader);
        assert.isOk(
          debugResult,
          "debugScanActiveReaderForTables returned null",
        );
        if (!debugResult) {
          return;
        }
        const debugSummary = formatDebugSummary(debugResult);
        const rawSummary = await inspectReaderTextAccess(reader, 1);
        const draftSummary = scanResult.tableDrafts.length
          ? scanResult.tableDrafts
              .map((draft, index) => describeDraft(draft, index))
              .join("\n")
          : "  <no tables detected>";

        const filePath = await attachment.getFilePathAsync();
        logRealPdfScanResult({
          query: REAL_PDF_TITLE_QUERY,
          attachment,
          filePath,
          scanResult,
          debugSummary,
          rawSummary,
        });

        assert.isAtLeast(
          scanResult.tableDrafts.length,
          REAL_PDF_MIN_TABLES,
          `Expected at least ${REAL_PDF_MIN_TABLES} table(s) for ${scanResult.itemTitle}, got ${scanResult.tableDrafts.length}. Diagnostics: ${scanResult.diagnostics.join(" | ")}\n${draftSummary}\n${debugSummary}\n${rawSummary}`,
        );

        const maxColumnCount = scanResult.tableDrafts.reduce(
          (maxValue, draft) => {
            const columnCount = Math.max(
              ...(draft.structuredRows?.map((row) => row.length) ?? [0]),
            );
            return Math.max(maxValue, columnCount);
          },
          0,
        );

        assert.isAtLeast(
          maxColumnCount,
          REAL_PDF_MIN_COLUMNS,
          `Expected at least ${REAL_PDF_MIN_COLUMNS} detected columns for ${scanResult.itemTitle}, got ${maxColumnCount}. Diagnostics: ${scanResult.diagnostics.join(" | ")}\n${draftSummary}\n${debugSummary}\n${rawSummary}`,
        );
      } finally {
        try {
          reader?.close?.();
        } catch {
          // Ignore cleanup failures in optional local regression tests.
        }
      }
    });
  });

  describe("datacheck audit", function () {
    it("flags repeated numeric sequences and invalid numeric ranges", function () {
      const table = parseTableSelection(
        createDraft(
          [
            "Condition\tValue A\tValue B\tp",
            "A\t10\t20\tp = 0.03",
            "B\t10\t20\tp = 1.20",
            "C\t55%\t120%\tp = 0.04",
          ].join("\n"),
        ),
      );
      const report = buildAuditReport(table);
      const duplicateNumericSequences = report.detectorResults.find(
        (result) => result.detectorId === "duplicate-numeric-sequences",
      );
      const invalidPValues = report.detectorResults.find(
        (result) => result.detectorId === "invalid-p-values",
      );
      const invalidPercentages = report.detectorResults.find(
        (result) => result.detectorId === "invalid-percentages",
      );

      assert.equal(report.findingCount, 3);
      assert.exists(duplicateNumericSequences);
      assert.equal(duplicateNumericSequences?.severity, "warning");
      assert.lengthOf(duplicateNumericSequences?.findings ?? [], 1);
      assert.exists(invalidPValues);
      assert.equal(invalidPValues?.severity, "warning");
      assert.lengthOf(invalidPValues?.findings ?? [], 1);
      assert.exists(invalidPercentages);
      assert.equal(invalidPercentages?.severity, "warning");
      assert.lengthOf(invalidPercentages?.findings ?? [], 1);
    });

    it("flags repeated numeric columns and dominant repeated values", function () {
      const table = parseTableSelection(
        createDraft(
          [
            "Condition\tMetric A\tMetric B\tConstant",
            "A\t1\t1\t9",
            "B\t2\t2\t9",
            "C\t3\t3\t9",
            "D\t4\t4\t9",
          ].join("\n"),
        ),
      );
      const report = buildAuditReport(table);
      const repeatedColumns = report.detectorResults.find(
        (result) => result.detectorId === "repeated-numeric-columns",
      );
      const uniformColumns = report.detectorResults.find(
        (result) => result.detectorId === "uniform-numeric-columns",
      );

      assert.exists(repeatedColumns);
      assert.equal(repeatedColumns?.severity, "warning");
      assert.lengthOf(repeatedColumns?.findings ?? [], 1);
      assert.exists(uniformColumns);
      assert.lengthOf(uniformColumns?.findings ?? [], 1);
    });

    it("flags Benford deviation when leading digits are heavily skewed", function () {
      const table = parseTableSelection(
        createDraft(
          [
            "ID\tValue",
            ...Array.from(
              { length: 20 },
              (_, index) => `R${index + 1}\t9${index + 10}`,
            ),
          ].join("\n"),
        ),
      );
      const report = buildAuditReport(table);
      const benfordResult = report.detectorResults.find(
        (result) => result.detectorId === "benford-deviation",
      );

      assert.exists(benfordResult);
      assert.equal(benfordResult?.applicability, "applied");
      assert.equal(benfordResult?.severity, "warning");
      assert.lengthOf(benfordResult?.findings ?? [], 1);
    });

    it("flags terminal digit preference and rounding heaping", function () {
      const table = parseTableSelection(
        createDraft(
          [
            "ID\tMetric",
            "A\t10",
            "B\t15",
            "C\t20",
            "D\t25",
            "E\t30",
            "F\t35",
            "G\t40",
            "H\t45",
            "I\t50",
            "J\t55",
            "K\t60",
            "L\t65",
            "M\t70",
            "N\t75",
            "O\t80",
            "P\t85",
            "Q\t90",
            "R\t95",
            "S\t100",
            "T\t105",
          ].join("\n"),
        ),
      );
      const report = buildAuditReport(table);
      const terminalDigitResult = report.detectorResults.find(
        (result) => result.detectorId === "terminal-digit-preference",
      );
      const roundingResult = report.detectorResults.find(
        (result) => result.detectorId === "rounding-heaping",
      );

      assert.exists(terminalDigitResult);
      assert.equal(terminalDigitResult?.severity, "warning");
      assert.lengthOf(terminalDigitResult?.findings ?? [], 1);
      assert.exists(roundingResult);
      assert.equal(roundingResult?.severity, "warning");
      assert.isAtLeast(roundingResult?.findings.length ?? 0, 1);
    });

    it("flags p-value threshold clustering near 0.05", function () {
      const table = parseTableSelection(
        createDraft(
          [
            "Study\tp",
            "A\tp = 0.049",
            "B\tp = 0.049",
            "C\tp = 0.048",
            "D\tp = 0.050",
            "E\tp = 0.049",
            "F\tp = 0.051",
            "G\tp = 0.056",
            "H\tp = 0.060",
          ].join("\n"),
        ),
      );
      const report = buildAuditReport(table);
      const clusteringResult = report.detectorResults.find(
        (result) => result.detectorId === "p-value-threshold-clustering",
      );

      assert.exists(clusteringResult);
      assert.equal(clusteringResult?.severity, "warning");
      assert.lengthOf(clusteringResult?.findings ?? [], 1);
    });

    it("flags low-variance columns and near-duplicate rows", function () {
      const table = parseTableSelection(
        createDraft(
          [
            "Method\tScore\tLatency\tMemory\tTag",
            "Base\t0.901\t101\t202\talpha",
            "Base-copy\t0.901\t101\t202\talpha",
            "Base-copy-2\t0.903\t101\t203\tgamma",
            "Variant\t0.904\t102\t203\tdelta",
            "Variant-2\t0.905\t102\t204\tepsilon",
          ].join("\n"),
        ),
      );
      const report = buildAuditReport(table);
      const nearDuplicateResult = report.detectorResults.find(
        (result) => result.detectorId === "near-duplicate-rows",
      );
      const lowVarianceResult = report.detectorResults.find(
        (result) => result.detectorId === "low-variance-numeric-columns",
      );

      assert.exists(nearDuplicateResult);
      assert.equal(nearDuplicateResult?.severity, "warning");
      assert.isAtLeast(nearDuplicateResult?.findings.length ?? 0, 1);
      assert.exists(lowVarianceResult);
      assert.isAtLeast(lowVarianceResult?.findings.length ?? 0, 1);
    });

    it("limits audit output to the selected detector set", function () {
      const table = parseTableSelection(
        createDraft(
          [
            "Condition\tValue A\tValue B\tp",
            "A\t10\t20\tp = 0.03",
            "B\t10\t20\tp = 1.20",
            "C\t55%\t120%\tp = 0.04",
          ].join("\n"),
        ),
      );
      const enabledDetectorIds: AuditDetectorId[] = ["invalid-percentages"];
      const report = buildAuditReport(table, { enabledDetectorIds });

      assert.lengthOf(report.detectorResults, 1);
      assert.equal(report.detectorResults[0].detectorId, "invalid-percentages");
      assert.equal(report.findingCount, 1);
    });
  });

  describe("datacheck selection popup", function () {
    it("keeps a single analyze button without removing sibling popup content", function () {
      const doc =
        Zotero.getMainWindow().document.implementation.createHTMLDocument(
          "datacheck-selection-popup",
        );
      const container = doc.createElement("div");
      doc.body.append(container);

      const translatePanel = doc.createElement("div");
      translatePanel.className = "pdf-translate-panel";
      translatePanel.textContent = "Translated text";
      container.append(translatePanel);

      const append: _ZoteroTypes.Reader.ReaderAppendType["appendDOM"] = (
        ...nodes
      ) => {
        container.append(...nodes);
      };

      appendSelectionPopupAnalyzeButton({
        doc,
        append,
        label: "Analyze Selection",
        onCommand: () => undefined,
      });
      appendSelectionPopupAnalyzeButton({
        doc,
        append,
        label: "Analyze Selection",
        onCommand: () => undefined,
      });

      assert.lengthOf(container.querySelectorAll("button"), 1);
      assert.equal(
        container.querySelector(".pdf-translate-panel")?.textContent,
        "Translated text",
      );
    });

    it("isolates popup append failures so sibling plugins can keep rendering", function () {
      const doc =
        Zotero.getMainWindow().document.implementation.createHTMLDocument(
          "datacheck-selection-popup-errors",
        );
      const container = doc.createElement("div");
      doc.body.append(container);

      const loggedErrors: Error[] = [];
      const append: _ZoteroTypes.Reader.ReaderAppendType["appendDOM"] = (
        ...nodes
      ) => {
        if (nodes.some((node) => (node as Element).nodeName === "BUTTON")) {
          throw new Error("datacheck popup append failed");
        }
        container.append(...nodes);
      };

      assert.doesNotThrow(() => {
        renderSelectionPopupAnalyzeAction({
          doc,
          append,
          label: "Analyze Selection",
          onCommand: () => undefined,
          reader: { tabID: "reader-1" },
          rememberSelection: () => undefined,
          logError: (error) => {
            loggedErrors.push(error);
          },
        });

        const translatePanel = doc.createElement("div");
        translatePanel.className = "pdf-translate-panel";
        translatePanel.textContent = "Translated text";
        append(translatePanel);
      });

      assert.lengthOf(loggedErrors, 1);
      assert.include(loggedErrors[0].message, "datacheck popup append failed");
      assert.lengthOf(container.querySelectorAll("button"), 0);
      assert.equal(
        container.querySelector(".pdf-translate-panel")?.textContent,
        "Translated text",
      );
    });

    it("hydrates empty selection text for PDF Translate popup compatibility", function () {
      const doc =
        Zotero.getMainWindow().document.implementation.createHTMLDocument(
          "datacheck-selection-popup-compatibility",
        );
      const container = doc.createElement("div");
      doc.body.append(container);

      const annotation = {
        text: "",
        position: {
          pageIndex: 0,
          rects: [[0, 0, 10, 10]],
        },
      } as any;
      const append: _ZoteroTypes.Reader.ReaderAppendType["appendDOM"] = (
        ...nodes
      ) => {
        container.append(...nodes);
      };
      const previousPDFTranslate = (Zotero as any).PDFTranslate;

      (Zotero as any).PDFTranslate = {
        data: {
          config: { addonRef: "zotero-pdf-translate" },
          translate: { selectedText: "" },
        },
        hooks: {
          onReaderPopupShow: ({ doc, append }: any) => {
            const panel = doc.createElement("div");
            panel.className = "zotero-pdf-translate-readerpopup";
            panel.textContent = (
              Zotero as any
            ).PDFTranslate.data.translate.selectedText;
            append(panel);
          },
        },
      };

      try {
        renderSelectionPopupAnalyzeAction({
          doc,
          append,
          label: "Analyze Selection",
          onCommand: () => undefined,
          reader: {
            tabID: "reader-1",
            _iframeWindow: {
              getSelection: () => ({
                toString: () => "Recovered table selection",
              }),
            },
          },
          annotation,
          rememberSelection: () => undefined,
        });

        assert.equal(annotation.text, "Recovered table selection");
        assert.equal(
          container.querySelector(".zotero-pdf-translate-readerpopup")
            ?.textContent,
          "Recovered table selection",
        );
        assert.lengthOf(container.querySelectorAll("button"), 1);
      } finally {
        (Zotero as any).PDFTranslate = previousPDFTranslate;
      }
    });
  });

  describe("datacheck report visuals", function () {
    it("builds leading-digit and column-mix profiles for report charts", function () {
      const table = parseTableSelection(
        createDraft(
          [
            "Group\tValue\tRate\tp",
            "A\t12\t10%\tp = 0.30",
            "B\t25\t20%\tp = 0.40",
            "C\t39\t30%\tp = 0.50",
          ].join("\n"),
        ),
      );

      const visuals = buildReportVisualizationModel(table);

      assert.equal(visuals.numericCellCount, 9);
      assert.equal(visuals.firstDigitSampleCount, 3);
      assert.equal(visuals.firstDigitBins[0].observedCount, 1);
      assert.equal(visuals.firstDigitBins[1].observedCount, 1);
      assert.equal(visuals.firstDigitBins[2].observedCount, 1);
      assert.lengthOf(visuals.columnProfiles, 3);
      assert.deepInclude(
        visuals.columnProfiles.find((profile) => profile.label === "Value (B)"),
        {
          total: 3,
          numberCount: 3,
          percentageCount: 0,
          pValueCount: 0,
        },
      );
      assert.deepInclude(
        visuals.columnProfiles.find((profile) => profile.label === "Rate (C)"),
        {
          total: 3,
          numberCount: 0,
          percentageCount: 3,
          pValueCount: 0,
        },
      );
      assert.deepInclude(
        visuals.columnProfiles.find((profile) => profile.label === "p (D)"),
        {
          total: 3,
          numberCount: 0,
          percentageCount: 0,
          pValueCount: 3,
        },
      );
    });
  });
});
