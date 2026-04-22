import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { buildAuditReport, buildBenfordProfile } from "./audit";
import { getAuditDetectorPreferenceDefinition } from "./detectors";
import { parseTableSelection } from "./parser";
import {
  createTableSelectionDraft,
  getActiveReaderContext,
  hydrateSelectionAnnotationText,
  rememberReaderSelection,
  scanActiveReaderForTables,
} from "./reader";
import {
  getEnabledAuditDetectorIds,
  isDataCheckEnabled,
} from "../../utils/prefs";
import type {
  AuditReport,
  ReaderTableScanResult,
  TableDocument,
  TableSelectionDraft,
} from "./types";

const FILE_MENU_SEPARATOR_ID = `${config.addonRef}-file-menu-separator`;
const FILE_MENU_ITEM_ID = `${config.addonRef}-file-menu-item`;
const SELECTION_POPUP_BUTTON_ATTRIBUTE = `data-${config.addonRef}-selection-popup-action`;

type NumericKindKey = "number" | "percentage" | "p-value";

interface LeadingDigitBin {
  digit: number;
  observedCount: number;
  observedRatio: number;
  expectedRatio: number;
}

interface NumericColumnProfile {
  label: string;
  total: number;
  numberCount: number;
  percentageCount: number;
  pValueCount: number;
}

export interface ReportVisualizationModel {
  firstDigitBins: LeadingDigitBin[];
  firstDigitSampleCount: number;
  columnProfiles: NumericColumnProfile[];
  maxColumnTotal: number;
  numericCellCount: number;
}

interface PdfAuditTableResult {
  index: number;
  draft: TableSelectionDraft;
  table: TableDocument;
  report: AuditReport;
}

export function appendSelectionPopupAnalyzeButton({
  doc,
  append,
  label,
  onCommand,
}: {
  doc: Document;
  append: _ZoteroTypes.Reader.ReaderAppendType["appendDOM"];
  label: string;
  onCommand: () => void;
}) {
  doc
    .querySelectorAll<HTMLButtonElement>(
      `button[${SELECTION_POPUP_BUTTON_ATTRIBUTE}]`,
    )
    .forEach((button: HTMLButtonElement) => button.remove());

  const button = doc.createElement("button");
  button.type = "button";
  button.setAttribute(SELECTION_POPUP_BUTTON_ATTRIBUTE, "analyze-current");
  button.textContent = label;
  button.style.marginInlineStart = "8px";
  button.style.padding = "4px 10px";
  button.style.borderRadius = "999px";
  button.style.border = "1px solid #d4b106";
  button.style.background = "#fff7d6";
  button.style.color = "#5b4a00";
  button.style.fontSize = "12px";
  button.style.cursor = "pointer";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCommand();
  });
  append(button);

  return button;
}

function normalizeReaderPopupError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function maybeRefreshPdfTranslatePopup({
  doc,
  append,
  reader,
  annotation,
  logError,
}: {
  doc: Document;
  append: _ZoteroTypes.Reader.ReaderAppendType["appendDOM"];
  reader: any;
  annotation?: _ZoteroTypes.Annotations.AnnotationJson;
  logError: (error: Error) => void;
}) {
  const pdfTranslate = (Zotero as any).PDFTranslate;
  const addonRef = pdfTranslate?.data?.config?.addonRef as string | undefined;
  const onReaderPopupShow = pdfTranslate?.hooks?.onReaderPopupShow as
    | ((
        event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
      ) => void)
    | undefined;
  const selectedText =
    typeof annotation?.text === "string" ? annotation.text.trim() : "";

  if (!addonRef || typeof onReaderPopupShow !== "function" || !selectedText) {
    return;
  }

  if (doc.querySelector(`.${addonRef}-readerpopup`)) {
    return;
  }

  try {
    if (pdfTranslate?.data?.translate) {
      pdfTranslate.data.translate.selectedText = selectedText;
    }

    onReaderPopupShow({
      doc,
      append,
      params: { annotation },
      reader,
    } as _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">);
  } catch (error) {
    logError(normalizeReaderPopupError(error));
  }
}

export function renderSelectionPopupAnalyzeAction({
  doc,
  append,
  label,
  onCommand,
  reader,
  annotation,
  rememberSelection = rememberReaderSelection,
  logError = (error: Error) => {
    Zotero.logError(error);
  },
}: {
  doc: Document;
  append: _ZoteroTypes.Reader.ReaderAppendType["appendDOM"];
  label: string;
  onCommand: () => void;
  reader: any;
  annotation?: _ZoteroTypes.Annotations.AnnotationJson;
  rememberSelection?: (
    reader: any,
    annotation?: _ZoteroTypes.Annotations.AnnotationJson,
  ) => void;
  logError?: (error: Error) => void;
}) {
  if (!isDataCheckEnabled()) {
    return undefined;
  }

  hydrateSelectionAnnotationText(reader, annotation);

  try {
    rememberSelection(reader, annotation);
  } catch (error) {
    logError(normalizeReaderPopupError(error));
  }

  maybeRefreshPdfTranslatePopup({
    doc,
    append,
    reader,
    annotation,
    logError,
  });

  try {
    return appendSelectionPopupAnalyzeButton({
      doc,
      append,
      label,
      onCommand,
    });
  } catch (error) {
    logError(normalizeReaderPopupError(error));
    return undefined;
  }
}

export function buildReportVisualizationModel(
  table: TableDocument,
): ReportVisualizationModel {
  const benfordProfile = buildBenfordProfile(table);
  const dataRows = table.rows.filter(
    (row) => row.index !== table.headerRowIndex,
  );
  const numericCells = dataRows.flatMap((row) => {
    return row.cells.flatMap((cell) => {
      const parsedNumeric = cell.parsedNumeric;
      if (!parsedNumeric) {
        return [];
      }

      return [
        {
          columnIndex: cell.columnIndex,
          kind: parsedNumeric.kind as NumericKindKey,
          value: parsedNumeric.value,
        },
      ];
    });
  });

  const columnProfiles = Array.from(
    { length: table.columnCount },
    (_, columnIndex) => {
      let numberCount = 0;
      let percentageCount = 0;
      let pValueCount = 0;

      for (const numericCell of numericCells) {
        if (numericCell.columnIndex !== columnIndex) {
          continue;
        }

        switch (numericCell.kind) {
          case "number":
            numberCount += 1;
            break;
          case "percentage":
            percentageCount += 1;
            break;
          case "p-value":
            pValueCount += 1;
            break;
        }
      }

      const total = numberCount + percentageCount + pValueCount;
      if (!total) {
        return undefined;
      }

      return {
        label: formatColumnLabel(table, columnIndex),
        total,
        numberCount,
        percentageCount,
        pValueCount,
      };
    },
  ).filter((profile): profile is NumericColumnProfile => Boolean(profile));

  return {
    firstDigitBins: benfordProfile.bins.map((bin) => ({
      digit: bin.digit,
      observedCount: bin.observedCount,
      observedRatio: bin.observedRatio,
      expectedRatio: bin.expectedRatio,
    })),
    firstDigitSampleCount: benfordProfile.sampleCount,
    columnProfiles,
    maxColumnTotal: columnProfiles.reduce((maxValue, profile) => {
      return Math.max(maxValue, profile.total);
    }, 0),
    numericCellCount: numericCells.length,
  };
}

export class DataCheckCommandFactory {
  private static readonly renderTextSelectionPopupHandler: _ZoteroTypes.Reader.EventHandler<"renderTextSelectionPopup"> =
    ({ doc, append, params, reader }) => {
      if (!isDataCheckEnabled()) {
        return;
      }

      renderSelectionPopupAnalyzeAction({
        doc,
        append,
        reader,
        annotation: params.annotation,
        label: getString("selection-popup-analyze-label"),
        onCommand: () => {
          void DataCheckCommandFactory.runAnalyzeCurrentReader();
        },
      });
    };

  private static readonly createSelectorContextMenuHandler: _ZoteroTypes.Reader.EventHandler<"createSelectorContextMenu"> =
    ({ append }) => {
      if (!isDataCheckEnabled()) {
        return;
      }

      append({
        label: getString("contextmenu-analyze-label"),
        onCommand: () => {
          void DataCheckCommandFactory.runAnalyzeCurrentReader();
        },
      });
    };

  private static readonly createViewContextMenuHandler: _ZoteroTypes.Reader.EventHandler<"createViewContextMenu"> =
    ({ append, reader }) => {
      if (!isDataCheckEnabled()) {
        return;
      }

      append({
        label: getString("contextmenu-analyze-pdf-label"),
        onCommand: () => {
          void DataCheckCommandFactory.runAnalyzeCurrentPdf(reader);
        },
      });
    };

  static registerReaderIntegration() {
    this.unregisterReaderIntegration();

    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      this.renderTextSelectionPopupHandler,
      config.addonID,
    );
    Zotero.Reader.registerEventListener(
      "createSelectorContextMenu",
      this.createSelectorContextMenuHandler,
      config.addonID,
    );
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      this.createViewContextMenuHandler,
      config.addonID,
    );
  }

  static unregisterReaderIntegration() {
    Zotero.Reader.unregisterEventListener(
      "renderTextSelectionPopup",
      this.renderTextSelectionPopupHandler,
    );
    Zotero.Reader.unregisterEventListener(
      "createSelectorContextMenu",
      this.createSelectorContextMenuHandler,
    );
    Zotero.Reader.unregisterEventListener(
      "createViewContextMenu",
      this.createViewContextMenuHandler,
    );
  }

  static registerWindowMenu(win: Window) {
    this.unregisterWindowMenu(win);
  }

  static unregisterWindowMenu(win: Window) {
    win.document.getElementById(FILE_MENU_SEPARATOR_ID)?.remove();
    win.document.getElementById(FILE_MENU_ITEM_ID)?.remove();
  }

  static registerPromptCommand() {
    ztoolkit.Prompt.register([
      {
        name: getString("prompt-command-name"),
        label: getString("prompt-command-label"),
        callback: () => void this.runAnalyzeCurrentReader(),
      },
    ]);
  }

  static async runAnalyzeCurrentReader() {
    try {
      if (!isDataCheckEnabled()) {
        this.showDisabledMessage();
        return;
      }

      const context = await getActiveReaderContext();
      if (!context) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({
            text: getString("command-reader-required"),
            type: "default",
            progress: 100,
          })
          .show();
        return;
      }

      const draft = createTableSelectionDraft(context);
  const enabledDetectorIds = getEnabledAuditDetectorIds();
      if (!draft.selectedTextLength) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({
            text: getString("command-selection-required"),
            type: "default",
            progress: 100,
          })
          .show();
        return;
      }

      const table = parseTableSelection(draft);
  const report = buildAuditReport(table, { enabledDetectorIds });

      addon.data.dataCheck.lastReaderContext = context;
      addon.data.dataCheck.lastSelectionDraft = draft;
      addon.data.dataCheck.lastTableDocument = table;
      addon.data.dataCheck.lastAuditReport = report;

      const popupWin = new ztoolkit.ProgressWindow(
        addon.data.config.addonName,
        {
          closeOnClick: true,
          closeTime: -1,
        },
      )
        .createLine({
          text: getString("command-analysis-complete"),
          type: "success",
          progress: 100,
        })
        .createLine({
          text: getString("command-draft-item", {
            args: { title: draft.itemTitle },
          }),
          type: "default",
        })
        .createLine({
          text: getString("command-draft-page", {
            args: { page: draft.pageNumber ?? "?" },
          }),
          type: "default",
        })
        .createLine({
          text: getString("command-analysis-table", {
            args: { rows: table.rowCount, cols: table.columnCount },
          }),
          type: "default",
        })
        .createLine({
          text: getString("command-analysis-findings", {
            args: { count: report.findingCount },
          }),
          type: "default",
        })
        .show();

      if (table.reconstructionWarnings.length) {
        popupWin.createLine({
          text: getString("command-analysis-warnings", {
            args: { count: table.reconstructionWarnings.length },
          }),
          type: "default",
        });
      }

      popupWin.startCloseTimer(6000);
      this.showAuditReportDialog(table, report);
    } catch (error) {
      const analysisError =
        error instanceof Error ? error : new Error(String(error));
      Zotero.logError(analysisError);

      const popupWin = new ztoolkit.ProgressWindow(
        addon.data.config.addonName,
        {
          closeOnClick: true,
          closeTime: -1,
        },
      )
        .createLine({
          text: getString("command-analysis-error"),
          type: "default",
          progress: 100,
        })
        .createLine({
          text: analysisError.message,
          type: "default",
        })
        .show();
      popupWin.startCloseTimer(8000);
    }
  }

  static async runAnalyzeCurrentPdf(reader?: any) {
    try {
      if (!isDataCheckEnabled()) {
        this.showDisabledMessage();
        return;
      }

      const scanResult = await scanActiveReaderForTables(reader);
      if (!scanResult) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({
            text: getString("command-reader-required"),
            type: "default",
            progress: 100,
          })
          .show();
        return;
      }

      const enabledDetectorIds = getEnabledAuditDetectorIds();
      const tableResults = scanResult.tableDrafts.map((draft, index) => {
        const table = parseTableSelection(draft);
        const report = buildAuditReport(table, { enabledDetectorIds });

        return {
          index: index + 1,
          draft,
          table,
          report,
        } satisfies PdfAuditTableResult;
      });

      if (!tableResults.length) {
        const popupWin = new ztoolkit.ProgressWindow(
          addon.data.config.addonName,
          {
            closeOnClick: true,
            closeTime: -1,
          },
        )
          .createLine({
            text: getString("command-pdf-analysis-none"),
            type: "default",
            progress: 100,
          })
          .createLine({
            text: getString("command-draft-item", {
              args: { title: scanResult.itemTitle },
            }),
            type: "default",
          })
          .createLine({
            text: getString("command-pdf-analysis-pages", {
              args: { pages: scanResult.pageCount },
            }),
            type: "default",
          })
          .show();

        if (scanResult.diagnostics.length) {
          popupWin.createLine({
            text: getString("command-pdf-analysis-diagnostics", {
              args: { count: scanResult.diagnostics.length },
            }),
            type: "default",
          });
        }

        popupWin.startCloseTimer(8000);
        return;
      }

      const totalFindings = tableResults.reduce((count, tableResult) => {
        return count + tableResult.report.findingCount;
      }, 0);

      addon.data.dataCheck.lastSelectionDraft = tableResults[0].draft;
      addon.data.dataCheck.lastTableDocument = tableResults[0].table;
      addon.data.dataCheck.lastAuditReport = tableResults[0].report;

      const popupWin = new ztoolkit.ProgressWindow(
        addon.data.config.addonName,
        {
          closeOnClick: true,
          closeTime: -1,
        },
      )
        .createLine({
          text: getString("command-pdf-analysis-complete", {
            args: { tables: tableResults.length },
          }),
          type: "success",
          progress: 100,
        })
        .createLine({
          text: getString("command-draft-item", {
            args: { title: scanResult.itemTitle },
          }),
          type: "default",
        })
        .createLine({
          text: getString("command-pdf-analysis-pages", {
            args: { pages: scanResult.pageCount },
          }),
          type: "default",
        })
        .createLine({
          text: getString("command-pdf-analysis-findings", {
            args: { count: totalFindings },
          }),
          type: "default",
        })
        .show();

      if (scanResult.diagnostics.length) {
        popupWin.createLine({
          text: getString("command-pdf-analysis-diagnostics", {
            args: { count: scanResult.diagnostics.length },
          }),
          type: "default",
        });
      }

      popupWin.startCloseTimer(7000);
      this.showPdfAuditReportDialog(scanResult, tableResults);
    } catch (error) {
      const analysisError =
        error instanceof Error ? error : new Error(String(error));
      Zotero.logError(analysisError);

      const popupWin = new ztoolkit.ProgressWindow(
        addon.data.config.addonName,
        {
          closeOnClick: true,
          closeTime: -1,
        },
      )
        .createLine({
          text: getString("command-analysis-error"),
          type: "default",
          progress: 100,
        })
        .createLine({
          text: analysisError.message,
          type: "default",
        })
        .show();
      popupWin.startCloseTimer(8000);
    }
  }

  private static showDisabledMessage() {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getString("command-disabled"),
        type: "default",
        progress: 100,
      })
      .show();
  }

  private static showAuditReportDialog(
    table: TableDocument,
    report: AuditReport,
  ) {
    addon.data.dialog?.window?.close();

    const dialogHelper = new ztoolkit.Dialog(1, 1)
      .addCell(
        0,
        0,
        {
          tag: "div",
          namespace: "html",
          properties: {
            innerHTML: this.renderAuditReportMarkup(table, report),
          },
          styles: {
            width: "920px",
            maxHeight: "640px",
            overflowY: "auto",
            paddingRight: "4px",
          },
        },
        false,
      )
      .addButton(getString("report-dialog-close"), "close")
      .open(getString("report-dialog-title"));

    addon.data.dialog = dialogHelper;
    dialogHelper.window?.addEventListener(
      "unload",
      () => {
        if (addon.data.dialog === dialogHelper) {
          addon.data.dialog = undefined;
        }
      },
      { once: true },
    );
  }

  private static showPdfAuditReportDialog(
    scanResult: ReaderTableScanResult,
    tableResults: PdfAuditTableResult[],
  ) {
    addon.data.dialog?.window?.close();

    const dialogHelper = new ztoolkit.Dialog(1, 1)
      .addCell(
        0,
        0,
        {
          tag: "div",
          namespace: "html",
          properties: {
            innerHTML: this.renderPdfAuditReportMarkup(
              scanResult,
              tableResults,
            ),
          },
          styles: {
            width: "980px",
            maxHeight: "680px",
            overflowY: "auto",
            paddingRight: "4px",
          },
        },
        false,
      )
      .addButton(getString("report-dialog-close"), "close")
      .open(getString("report-dialog-title-pdf"));

    addon.data.dialog = dialogHelper;
    dialogHelper.window?.addEventListener(
      "unload",
      () => {
        if (addon.data.dialog === dialogHelper) {
          addon.data.dialog = undefined;
        }
      },
      { once: true },
    );
  }

  private static renderAuditReportMarkup(
    table: TableDocument,
    report: AuditReport,
  ): string {
    const visualizationModel = buildReportVisualizationModel(table);
    const sourceLabel = this.getSourceLabel(table.source);
    const benfordEnabled = report.detectorResults.some(
      (detectorResult) => detectorResult.detectorId === "benford-deviation",
    );
    const detectorMarkup = report.detectorResults.length
      ? report.detectorResults
      .map((detectorResult) => {
        const toneClass =
          detectorResult.severity === "warning"
            ? "dc-detector-warning"
            : "dc-detector-info";
        const findingPreview = detectorResult.findings.length
          ? `<div class="dc-preview-list">${detectorResult.findings
              .slice(0, 3)
              .map(
                (finding) =>
                  `<div class="dc-preview-item">${escapeHtml(finding.message)}</div>`,
              )
              .join("")}</div>`
          : "";
        return `<article class="dc-detector-card ${toneClass}">
          <div class="dc-detector-head">
            <div>
              <div class="dc-detector-title">${escapeHtml(getDetectorTitle(detectorResult.detectorId))}</div>
              <div class="dc-detector-summary">${escapeHtml(detectorResult.summary)}</div>
            </div>
            <div class="dc-chip-row">
              <span class="dc-chip ${detectorResult.severity === "warning" ? "dc-chip-warning" : "dc-chip-info"}">${escapeHtml(getSeverityLabel(detectorResult.severity))}</span>
              <span class="dc-chip dc-chip-count">${detectorResult.findings.length}</span>
            </div>
          </div>
          ${findingPreview}
        </article>`;
      })
      .join("")
      : `<div class="dc-empty-state">${escapeHtml(getString("report-empty-detectors"))}</div>`;
    const flattenedFindings = report.detectorResults.flatMap(
      (detectorResult) => {
        return detectorResult.findings.map((finding) => ({
          detectorId: detectorResult.detectorId,
          message: finding.message,
        }));
      },
    );
    const findingsMarkup = flattenedFindings.length
      ? flattenedFindings
          .map(
            (finding) => `<div class="dc-finding-card">
            <div class="dc-finding-label">${escapeHtml(getDetectorTitle(finding.detectorId))}</div>
            <div class="dc-finding-message">${escapeHtml(finding.message)}</div>
          </div>`,
          )
          .join("")
      : `<div class="dc-empty-state">${escapeHtml(getString("report-empty-findings"))}</div>`;
    const diagnosticsMarkup = report.tableDiagnostics.length
      ? report.tableDiagnostics
          .map(
            (diagnostic) =>
              `<div class="dc-diagnostic-card">${escapeHtml(diagnostic)}</div>`,
          )
          .join("")
      : `<div class="dc-empty-state">${escapeHtml(getString("report-empty-diagnostics"))}</div>`;

    return `${this.renderReportStyles()}
    <div class="dc-report">
      <header class="dc-hero">
        <div class="dc-hero-title">${escapeHtml(getString("report-dialog-title"))}</div>
        <div class="dc-hero-summary">${escapeHtml(report.summary)}</div>
      </header>

      <div class="dc-metrics">
        ${this.renderMetricCard(getString("report-card-table"), `${table.rowCount} x ${table.columnCount}`, getString("report-card-page-detail", { args: { page: table.pageNumber ?? "?" } }), "sky")}
        ${this.renderMetricCard(getString("report-card-numeric"), String(table.numericCellCount), getString("report-card-header-detail", { args: { count: table.header ? table.header.length : 0 } }), "mint")}
        ${this.renderMetricCard(getString("report-card-findings"), String(report.findingCount), getString("report-card-flagged-detail", { args: { count: report.detectorResults.filter((result) => result.findings.length).length } }), "amber")}
        ${this.renderMetricCard(getString("report-card-source"), sourceLabel, table.selectionRectCount ? getString("report-card-rect-detail", { args: { count: table.selectionRectCount } }) : table.attachmentKey, "violet")}
      </div>

      <div class="dc-sections">
        <section class="dc-section">
          <div class="dc-section-title">${escapeHtml(getString("report-section-visuals"))}</div>
          <div class="dc-visual-grid">
            ${benfordEnabled ? this.renderLeadingDigitPanel(visualizationModel) : ""}
            ${this.renderColumnProfilePanel(visualizationModel)}
          </div>
        </section>

        <section class="dc-section">
          <div class="dc-section-title">${escapeHtml(getString("report-section-diagnostics"))}</div>
          <div class="dc-stack">${diagnosticsMarkup}</div>
        </section>

        <section class="dc-section">
          <div class="dc-section-title">${escapeHtml(getString("report-section-detectors"))}</div>
          <div class="dc-stack">${detectorMarkup}</div>
        </section>

        <section class="dc-section">
          <div class="dc-section-title">${escapeHtml(getString("report-section-findings"))}</div>
          <div class="dc-stack dc-stack-tight">${findingsMarkup}</div>
        </section>
      </div>
    </div>`;
  }

  private static renderPdfAuditReportMarkup(
    scanResult: ReaderTableScanResult,
    tableResults: PdfAuditTableResult[],
  ): string {
    const totalFindings = tableResults.reduce((count, tableResult) => {
      return count + tableResult.report.findingCount;
    }, 0);
    const flaggedTables = tableResults.filter(
      (tableResult) => tableResult.report.findingCount,
    ).length;
    const detectedPages = new Set(
      tableResults.map((tableResult) => tableResult.table.pageNumber ?? 0),
    ).size;
    const diagnosticsMarkup = scanResult.diagnostics.length
      ? scanResult.diagnostics
          .map(
            (diagnostic) =>
              `<div class="dc-diagnostic-card">${escapeHtml(diagnostic)}</div>`,
          )
          .join("")
      : `<div class="dc-empty-state">${escapeHtml(getString("report-empty-diagnostics"))}</div>`;
    const tablesMarkup = tableResults
      .map((tableResult) => this.renderPdfTableSummaryCard(tableResult))
      .join("");

    return `${this.renderReportStyles()}
    <div class="dc-report">
      <header class="dc-hero">
        <div class="dc-hero-title">${escapeHtml(getString("report-dialog-title-pdf"))}</div>
        <div class="dc-hero-summary">${escapeHtml(
          getString("report-pdf-summary", {
            args: {
              pages: scanResult.pageCount,
              tables: tableResults.length,
              findings: totalFindings,
            },
          }),
        )}</div>
      </header>

      <div class="dc-metrics">
        ${this.renderMetricCard(
          getString("report-pdf-card-pages"),
          String(scanResult.pageCount),
          getString("command-draft-item", {
            args: { title: scanResult.itemTitle },
          }),
          "sky",
        )}
        ${this.renderMetricCard(
          getString("report-pdf-card-tables"),
          String(tableResults.length),
          getString("report-pdf-card-detected-pages", {
            args: { count: detectedPages },
          }),
          "mint",
        )}
        ${this.renderMetricCard(
          getString("report-card-findings"),
          String(totalFindings),
          getString("report-pdf-card-flagged-tables", {
            args: { count: flaggedTables },
          }),
          "amber",
        )}
        ${this.renderMetricCard(
          getString("report-card-source"),
          getString("report-source-pdf-scan"),
          scanResult.attachmentKey,
          "violet",
        )}
      </div>

      <div class="dc-sections">
        <section class="dc-section">
          <div class="dc-section-title">${escapeHtml(getString("report-section-diagnostics"))}</div>
          <div class="dc-stack">${diagnosticsMarkup}</div>
        </section>

        <section class="dc-section">
          <div class="dc-section-title">${escapeHtml(getString("report-section-tables"))}</div>
          <div class="dc-stack">${tablesMarkup}</div>
        </section>
      </div>
    </div>`;
  }

  private static renderPdfTableSummaryCard(
    tableResult: PdfAuditTableResult,
  ): string {
    const { index, table, report } = tableResult;
    const flattenedFindings = report.detectorResults
      .flatMap((detectorResult) => {
        return detectorResult.findings.map((finding) => ({
          detectorId: detectorResult.detectorId,
          message: finding.message,
        }));
      })
      .slice(0, 3);
    const findingsMarkup = flattenedFindings.length
      ? flattenedFindings
          .map(
            (finding) => `<div class="dc-preview-item">
            <div class="dc-finding-label">${escapeHtml(getDetectorTitle(finding.detectorId))}</div>
            <div class="dc-finding-message">${escapeHtml(finding.message)}</div>
          </div>`,
          )
          .join("")
      : `<div class="dc-empty-state">${escapeHtml(getString("report-empty-findings"))}</div>`;
    const diagnosticsMarkup = report.tableDiagnostics.length
      ? report.tableDiagnostics
          .slice(0, 3)
          .map(
            (diagnostic) =>
              `<div class="dc-diagnostic-card">${escapeHtml(diagnostic)}</div>`,
          )
          .join("")
      : `<div class="dc-empty-state">${escapeHtml(getString("report-empty-diagnostics"))}</div>`;
    const severity = report.findingCount ? "warning" : "info";

    return `<article class="dc-panel dc-table-summary-card">
      <div class="dc-panel-head">
        <div>
          <div class="dc-panel-title">${escapeHtml(
            getString("report-pdf-table-title", {
              args: {
                index,
                page: table.pageNumber ?? "?",
              },
            }),
          )}</div>
          <div class="dc-panel-detail">${escapeHtml(report.summary)}</div>
        </div>
        <div class="dc-chip-row">
          <span class="dc-chip ${severity === "warning" ? "dc-chip-warning" : "dc-chip-info"}">${escapeHtml(getSeverityLabel(severity))}</span>
          <span class="dc-chip dc-chip-count">${report.findingCount}</span>
        </div>
      </div>

      <div class="dc-metrics dc-metrics-compact">
        ${this.renderMetricCard(
          getString("report-card-table"),
          `${table.rowCount} x ${table.columnCount}`,
          getString("report-card-page-detail", {
            args: { page: table.pageNumber ?? "?" },
          }),
          "sky",
        )}
        ${this.renderMetricCard(
          getString("report-card-numeric"),
          String(table.numericCellCount),
          getString("report-card-header-detail", {
            args: { count: table.header ? table.header.length : 0 },
          }),
          "mint",
        )}
        ${this.renderMetricCard(
          getString("report-card-source"),
          this.getSourceLabel(table.source),
          getString("report-card-flagged-detail", {
            args: {
              count: report.detectorResults.filter(
                (detectorResult) => detectorResult.findings.length,
              ).length,
            },
          }),
          "amber",
        )}
      </div>

      <div class="dc-stack dc-stack-tight">
        <div class="dc-subsection-label">${escapeHtml(getString("report-section-findings"))}</div>
        <div class="dc-stack dc-stack-tight">${findingsMarkup}</div>
        <div class="dc-subsection-label">${escapeHtml(getString("report-section-diagnostics"))}</div>
        <div class="dc-stack dc-stack-tight">${diagnosticsMarkup}</div>
      </div>
    </article>`;
  }

  private static getSourceLabel(source: TableDocument["source"]): string {
    switch (source) {
      case "reader-structured-selection":
        return getString("report-source-structured");
      case "reader-pdf-table-scan":
        return getString("report-source-pdf-scan");
      default:
        return getString("report-source-text");
    }
  }

  private static renderMetricCard(
    label: string,
    value: string,
    detail: string,
    tone: "sky" | "mint" | "amber" | "violet",
  ): string {
    return `<article class="dc-metric-card dc-tone-${tone}">
      <div class="dc-metric-label">${escapeHtml(label)}</div>
      <div class="dc-metric-value">${escapeHtml(value)}</div>
      <div class="dc-metric-detail">${escapeHtml(detail)}</div>
    </article>`;
  }

  private static renderLeadingDigitPanel(
    visualizationModel: ReportVisualizationModel,
  ): string {
    const chartMarkup = visualizationModel.firstDigitSampleCount
      ? visualizationModel.firstDigitBins
          .map(
            (bin) => `<div class="dc-chart-row">
            <div class="dc-chart-row-head">
              <span class="dc-chart-label">${bin.digit}</span>
              <span class="dc-chart-value">${formatPercentage(bin.observedRatio)}</span>
            </div>
            <div class="dc-chart-track">
              <div class="dc-chart-benchmark" style="width:${toTrackWidth(bin.expectedRatio)}"></div>
              <div class="dc-chart-bar" style="width:${toTrackWidth(bin.observedRatio)}"></div>
            </div>
            <div class="dc-chart-caption">${escapeHtml(getString("report-visual-legend-expected"))} ${formatPercentage(bin.expectedRatio)} · ${bin.observedCount}</div>
          </div>`,
          )
          .join("")
      : `<div class="dc-empty-state">${escapeHtml(getString("report-visual-leading-digits-empty"))}</div>`;

    return `<article class="dc-panel">
      <div class="dc-panel-head">
        <div>
          <div class="dc-panel-title">${escapeHtml(getString("report-visual-leading-digits-title"))}</div>
          <div class="dc-panel-detail">${escapeHtml(getString("report-visual-leading-digits-detail"))}</div>
        </div>
        <div class="dc-panel-meta">${escapeHtml(getString("report-visual-sample-count", { args: { count: visualizationModel.firstDigitSampleCount } }))}</div>
      </div>
      <div class="dc-legend-row">
        ${this.renderLegendItem(getString("report-visual-legend-observed"), "dc-swatch-observed")}
        ${this.renderLegendItem(getString("report-visual-legend-expected"), "dc-swatch-expected")}
      </div>
      <div class="dc-chart-list">${chartMarkup}</div>
    </article>`;
  }

  private static renderColumnProfilePanel(
    visualizationModel: ReportVisualizationModel,
  ): string {
    const chartMarkup = visualizationModel.columnProfiles.length
      ? visualizationModel.columnProfiles
          .map((profile) => {
            const totalShare = visualizationModel.maxColumnTotal
              ? profile.total / visualizationModel.maxColumnTotal
              : 0;
            return `<div class="dc-chart-row">
              <div class="dc-chart-row-head">
                <span class="dc-chart-label dc-chart-label-wide">${escapeHtml(profile.label)}</span>
                <span class="dc-chart-value">${profile.total}</span>
              </div>
              <div class="dc-column-track">
                <div class="dc-column-bar" style="width:${toTrackWidth(totalShare, 18)}">
                  ${profile.numberCount ? `<span class="dc-column-segment dc-column-segment-number" style="width:${toSegmentWidth(profile.numberCount, profile.total)}"></span>` : ""}
                  ${profile.percentageCount ? `<span class="dc-column-segment dc-column-segment-percentage" style="width:${toSegmentWidth(profile.percentageCount, profile.total)}"></span>` : ""}
                  ${profile.pValueCount ? `<span class="dc-column-segment dc-column-segment-pvalue" style="width:${toSegmentWidth(profile.pValueCount, profile.total)}"></span>` : ""}
                </div>
              </div>
              <div class="dc-chart-caption">${escapeHtml(getString("report-visual-column-caption", { args: { numbers: profile.numberCount, percentages: profile.percentageCount, pvalues: profile.pValueCount } }))}</div>
            </div>`;
          })
          .join("")
      : `<div class="dc-empty-state">${escapeHtml(getString("report-visual-column-profile-empty"))}</div>`;

    return `<article class="dc-panel">
      <div class="dc-panel-head">
        <div>
          <div class="dc-panel-title">${escapeHtml(getString("report-visual-column-profile-title"))}</div>
          <div class="dc-panel-detail">${escapeHtml(getString("report-visual-column-profile-detail"))}</div>
        </div>
        <div class="dc-panel-meta">${escapeHtml(getString("report-visual-column-total", { args: { count: visualizationModel.numericCellCount } }))}</div>
      </div>
      <div class="dc-legend-row">
        ${this.renderLegendItem(getString("report-visual-legend-number"), "dc-swatch-number")}
        ${this.renderLegendItem(getString("report-visual-legend-percentage"), "dc-swatch-percentage")}
        ${this.renderLegendItem(getString("report-visual-legend-pvalue"), "dc-swatch-pvalue")}
      </div>
      <div class="dc-chart-list">${chartMarkup}</div>
    </article>`;
  }

  private static renderLegendItem(label: string, swatchClass: string): string {
    return `<div class="dc-legend-item"><span class="dc-swatch ${swatchClass}"></span><span>${escapeHtml(label)}</span></div>`;
  }

  private static renderReportStyles(): string {
    return `<style>
      .dc-report {
        --dc-bg: linear-gradient(180deg, #f8fbff 0%, #f1f5f9 100%);
        --dc-surface: rgba(255, 255, 255, 0.84);
        --dc-surface-strong: rgba(255, 255, 255, 0.96);
        --dc-border: rgba(148, 163, 184, 0.28);
        --dc-border-strong: rgba(148, 163, 184, 0.42);
        --dc-text: #11203b;
        --dc-muted: #526277;
        --dc-subtle: #6b7b92;
        --dc-shadow: 0 20px 48px rgba(15, 23, 42, 0.12);
        --dc-sky-bg: linear-gradient(180deg, rgba(219, 234, 254, 0.92), rgba(239, 246, 255, 0.9));
        --dc-sky-border: rgba(96, 165, 250, 0.45);
        --dc-mint-bg: linear-gradient(180deg, rgba(204, 251, 241, 0.92), rgba(236, 253, 245, 0.9));
        --dc-mint-border: rgba(45, 212, 191, 0.4);
        --dc-amber-bg: linear-gradient(180deg, rgba(254, 243, 199, 0.92), rgba(255, 247, 237, 0.9));
        --dc-amber-border: rgba(251, 191, 36, 0.4);
        --dc-violet-bg: linear-gradient(180deg, rgba(233, 213, 255, 0.92), rgba(245, 243, 255, 0.9));
        --dc-violet-border: rgba(167, 139, 250, 0.36);
        --dc-info: #2563eb;
        --dc-info-soft: rgba(59, 130, 246, 0.14);
        --dc-warn: #d97706;
        --dc-warn-soft: rgba(245, 158, 11, 0.16);
        --dc-observed: linear-gradient(90deg, #38bdf8 0%, #2563eb 100%);
        --dc-expected: rgba(37, 99, 235, 0.16);
        --dc-number: linear-gradient(90deg, #14b8a6 0%, #0f766e 100%);
        --dc-percentage: linear-gradient(90deg, #f59e0b 0%, #d97706 100%);
        --dc-pvalue: linear-gradient(90deg, #8b5cf6 0%, #6d28d9 100%);
        box-sizing: border-box;
        width: 100%;
        padding: 22px;
        border-radius: 24px;
        background: var(--dc-bg);
        color: var(--dc-text);
        font-family: "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif;
        box-shadow: var(--dc-shadow);
      }

      @media (prefers-color-scheme: dark) {
        .dc-report {
          --dc-bg: radial-gradient(circle at top left, rgba(56, 189, 248, 0.14), transparent 34%), linear-gradient(180deg, #09111f 0%, #0f172a 48%, #131c31 100%);
          --dc-surface: rgba(15, 23, 42, 0.76);
          --dc-surface-strong: rgba(15, 23, 42, 0.9);
          --dc-border: rgba(148, 163, 184, 0.18);
          --dc-border-strong: rgba(148, 163, 184, 0.26);
          --dc-text: #e8eefc;
          --dc-muted: #b5c2d6;
          --dc-subtle: #8ea0bb;
          --dc-shadow: 0 22px 50px rgba(0, 0, 0, 0.35);
          --dc-sky-bg: linear-gradient(180deg, rgba(30, 64, 175, 0.32), rgba(14, 116, 144, 0.16));
          --dc-sky-border: rgba(96, 165, 250, 0.34);
          --dc-mint-bg: linear-gradient(180deg, rgba(13, 148, 136, 0.28), rgba(6, 78, 59, 0.12));
          --dc-mint-border: rgba(45, 212, 191, 0.28);
          --dc-amber-bg: linear-gradient(180deg, rgba(180, 83, 9, 0.28), rgba(120, 53, 15, 0.14));
          --dc-amber-border: rgba(251, 191, 36, 0.26);
          --dc-violet-bg: linear-gradient(180deg, rgba(109, 40, 217, 0.28), rgba(76, 29, 149, 0.16));
          --dc-violet-border: rgba(167, 139, 250, 0.24);
          --dc-info: #7dd3fc;
          --dc-info-soft: rgba(56, 189, 248, 0.16);
          --dc-warn: #fbbf24;
          --dc-warn-soft: rgba(251, 191, 36, 0.16);
          --dc-observed: linear-gradient(90deg, #67e8f9 0%, #38bdf8 100%);
          --dc-expected: rgba(125, 211, 252, 0.24);
          --dc-number: linear-gradient(90deg, #5eead4 0%, #14b8a6 100%);
          --dc-percentage: linear-gradient(90deg, #fcd34d 0%, #f59e0b 100%);
          --dc-pvalue: linear-gradient(90deg, #c4b5fd 0%, #8b5cf6 100%);
        }
      }

      .dc-report * {
        box-sizing: border-box;
      }

      .dc-hero,
      .dc-panel,
      .dc-detector-card,
      .dc-finding-card,
      .dc-empty-state,
      .dc-diagnostic-card,
      .dc-metric-card {
        backdrop-filter: blur(10px);
      }

      .dc-hero {
        padding: 18px 20px;
        border-radius: 22px;
        border: 1px solid var(--dc-border);
        background: linear-gradient(135deg, var(--dc-surface-strong) 0%, var(--dc-surface) 100%);
      }

      .dc-hero-title {
        font-size: 30px;
        font-weight: 800;
        letter-spacing: -0.03em;
      }

      .dc-hero-summary {
        margin-top: 8px;
        color: var(--dc-muted);
        font-size: 14px;
        line-height: 1.7;
      }

      .dc-metrics,
      .dc-metrics-compact,
      .dc-visual-grid {
        display: grid;
        gap: 12px;
      }

      .dc-metrics {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .dc-metrics-compact {
        margin-top: 14px;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .dc-metrics {
        margin-top: 16px;
      }

      .dc-sections {
        display: grid;
        gap: 18px;
        margin-top: 18px;
      }

      .dc-section {
        display: grid;
        gap: 12px;
      }

      .dc-section-title {
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--dc-subtle);
      }

      .dc-stack {
        display: grid;
        gap: 10px;
      }

      .dc-stack-tight {
        gap: 8px;
      }

      .dc-metric-card,
      .dc-panel,
      .dc-detector-card,
      .dc-finding-card,
      .dc-empty-state,
      .dc-diagnostic-card {
        border-radius: 20px;
        border: 1px solid var(--dc-border);
        background: linear-gradient(180deg, var(--dc-surface-strong) 0%, var(--dc-surface) 100%);
      }

      .dc-metric-card {
        padding: 16px;
        min-height: 124px;
      }

      .dc-tone-sky {
        background: var(--dc-sky-bg);
        border-color: var(--dc-sky-border);
      }

      .dc-tone-mint {
        background: var(--dc-mint-bg);
        border-color: var(--dc-mint-border);
      }

      .dc-tone-amber {
        background: var(--dc-amber-bg);
        border-color: var(--dc-amber-border);
      }

      .dc-tone-violet {
        background: var(--dc-violet-bg);
        border-color: var(--dc-violet-border);
      }

      .dc-metric-label,
      .dc-finding-label,
      .dc-chart-caption,
      .dc-panel-detail,
      .dc-panel-meta,
      .dc-metric-detail {
        color: var(--dc-muted);
      }

      .dc-metric-label {
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .dc-metric-value {
        margin-top: 12px;
        font-size: 34px;
        line-height: 1;
        font-weight: 800;
        letter-spacing: -0.03em;
      }

      .dc-metric-detail {
        margin-top: 8px;
        line-height: 1.55;
      }

      .dc-panel,
      .dc-detector-card,
      .dc-finding-card,
      .dc-empty-state,
      .dc-diagnostic-card {
        padding: 16px;
      }

      .dc-table-summary-card {
        display: grid;
        gap: 14px;
      }

      .dc-visual-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .dc-panel-head,
      .dc-detector-head,
      .dc-chart-row-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .dc-panel-title,
      .dc-detector-title {
        font-size: 16px;
        font-weight: 800;
        color: var(--dc-text);
      }

      .dc-panel-detail,
      .dc-detector-summary,
      .dc-finding-message {
        margin-top: 6px;
        line-height: 1.6;
      }

      .dc-panel-meta {
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--dc-border);
        background: rgba(255, 255, 255, 0.24);
        font-size: 12px;
        font-weight: 700;
        white-space: nowrap;
      }

      .dc-legend-row,
      .dc-chip-row,
      .dc-legend-item {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .dc-legend-row {
        margin-top: 12px;
      }

      .dc-legend-item {
        color: var(--dc-subtle);
        font-size: 12px;
      }

      .dc-swatch {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        display: inline-block;
      }

      .dc-swatch-observed {
        background: var(--dc-observed);
      }

      .dc-swatch-expected {
        background: var(--dc-expected);
        border: 1px solid rgba(37, 99, 235, 0.28);
      }

      .dc-swatch-number {
        background: var(--dc-number);
      }

      .dc-swatch-percentage {
        background: var(--dc-percentage);
      }

      .dc-swatch-pvalue {
        background: var(--dc-pvalue);
      }

      .dc-chart-list,
      .dc-preview-list {
        display: grid;
        gap: 10px;
      }

      .dc-chart-list {
        margin-top: 14px;
      }

      .dc-chart-row {
        display: grid;
        gap: 6px;
      }

      .dc-chart-label {
        font-weight: 700;
        color: var(--dc-text);
      }

      .dc-chart-label-wide {
        max-width: 75%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dc-chart-value {
        font-weight: 800;
        color: var(--dc-text);
      }

      .dc-chart-track,
      .dc-column-track {
        position: relative;
        height: 12px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.18);
        overflow: hidden;
      }

      .dc-chart-benchmark,
      .dc-chart-bar,
      .dc-column-bar,
      .dc-column-segment {
        position: absolute;
        inset-block: 0;
        left: 0;
        border-radius: inherit;
      }

      .dc-chart-benchmark {
        background: var(--dc-expected);
      }

      .dc-chart-bar {
        background: var(--dc-observed);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14) inset;
      }

      .dc-column-bar {
        display: flex;
        position: absolute;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.08);
      }

      .dc-column-segment {
        position: static;
        min-width: 0;
      }

      .dc-column-segment-number {
        background: var(--dc-number);
      }

      .dc-column-segment-percentage {
        background: var(--dc-percentage);
      }

      .dc-column-segment-pvalue {
        background: var(--dc-pvalue);
      }

      .dc-diagnostic-card {
        color: var(--dc-warn);
        border-color: rgba(245, 158, 11, 0.32);
        background: linear-gradient(180deg, var(--dc-warn-soft) 0%, rgba(255, 255, 255, 0.04) 100%);
        line-height: 1.6;
      }

      .dc-detector-card {
        border-color: var(--dc-border-strong);
      }

      .dc-detector-warning {
        background: linear-gradient(180deg, var(--dc-warn-soft) 0%, var(--dc-surface) 100%);
      }

      .dc-detector-info {
        background: linear-gradient(180deg, var(--dc-info-soft) 0%, var(--dc-surface) 100%);
      }

      .dc-chip {
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .dc-chip-info {
        background: var(--dc-info-soft);
        color: var(--dc-info);
      }

      .dc-chip-warning {
        background: var(--dc-warn-soft);
        color: var(--dc-warn);
      }

      .dc-chip-count {
        background: rgba(15, 23, 42, 0.9);
        color: #ffffff;
      }

      @media (prefers-color-scheme: dark) {
        .dc-chip-count {
          background: rgba(226, 232, 240, 0.14);
          color: var(--dc-text);
        }
      }

      .dc-preview-list {
        margin-top: 12px;
      }

      .dc-preview-item,
      .dc-finding-card,
      .dc-empty-state {
        border: 1px solid var(--dc-border);
      }

      .dc-preview-item {
        padding: 10px 12px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.26);
        line-height: 1.55;
        color: var(--dc-text);
      }

      .dc-finding-label {
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .dc-subsection-label {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--dc-subtle);
      }

      .dc-empty-state {
        color: var(--dc-muted);
        border-style: dashed;
        line-height: 1.6;
      }

      @media (max-width: 900px) {
        .dc-report {
          padding: 18px;
        }

        .dc-metrics,
        .dc-metrics-compact,
        .dc-visual-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 640px) {
        .dc-metrics,
        .dc-metrics-compact,
        .dc-visual-grid {
          grid-template-columns: minmax(0, 1fr);
        }

        .dc-panel-head,
        .dc-detector-head,
        .dc-chart-row-head {
          flex-direction: column;
          align-items: flex-start;
        }

        .dc-panel-meta {
          white-space: normal;
        }
      }
    </style>`;
  }
}

function _getLeadingDigit(_value: number): number | undefined {
  return undefined;
}

function formatPercentage(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function toTrackWidth(ratio: number, minVisible = 4): string {
  if (ratio <= 0) {
    return "0%";
  }

  return `${Math.min(100, Math.max(ratio * 100, minVisible))}%`;
}

function toSegmentWidth(count: number, total: number): string {
  if (!count || !total) {
    return "0%";
  }

  return `${(count / total) * 100}%`;
}

function getDetectorTitle(detectorId: string): string {
  const detector = getAuditDetectorPreferenceDefinition(detectorId);
  if (detector) {
    return getString(detector.titleL10nId);
  }

  return humanizeDetectorId(detectorId);
}

function getSeverityLabel(
  severity: AuditReport["detectorResults"][number]["severity"],
): string {
  return severity === "warning"
    ? getString("report-severity-warning")
    : getString("report-severity-info");
}

function formatColumnLabel(table: TableDocument, columnIndex: number): string {
  const columnRef = String.fromCharCode(65 + columnIndex);
  const headerText = table.header?.[columnIndex]?.trim();
  return headerText ? `${headerText} (${columnRef})` : columnRef;
}

function humanizeDetectorId(detectorId: string): string {
  return detectorId
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
