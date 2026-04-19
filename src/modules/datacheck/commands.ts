import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { buildAuditReport, formatAuditReport } from "./audit";
import { parseTableSelection } from "./parser";
import {
  createTableSelectionDraft,
  getActiveReaderContext,
  rememberReaderSelection,
} from "./reader";
import type { AuditReport, TableDocument } from "./types";

const FILE_MENU_SEPARATOR_ID = `${config.addonRef}-file-menu-separator`;
const FILE_MENU_ITEM_ID = `${config.addonRef}-file-menu-item`;
const SELECTION_POPUP_BUTTON_ATTRIBUTE =
  `data-${config.addonRef}-selection-popup-action`;

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

export class DataCheckCommandFactory {
  private static readonly renderTextSelectionPopupHandler: _ZoteroTypes.Reader.EventHandler<"renderTextSelectionPopup"> = ({
    doc,
    append,
    params,
    reader,
  }) => {
    rememberReaderSelection(reader, params.annotation);
    appendSelectionPopupAnalyzeButton({
      doc,
      append,
      label: getString("selection-popup-analyze-label"),
      onCommand: () => {
        void DataCheckCommandFactory.runAnalyzeCurrentReader();
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
  }

  static unregisterReaderIntegration() {
    Zotero.Reader.unregisterEventListener(
      "renderTextSelectionPopup",
      this.renderTextSelectionPopupHandler,
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
      const report = buildAuditReport(table);

      addon.data.dataCheck.lastReaderContext = context;
      addon.data.dataCheck.lastSelectionDraft = draft;
      addon.data.dataCheck.lastTableDocument = table;
      addon.data.dataCheck.lastAuditReport = report;

      const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: -1,
      })
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

      const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: -1,
      })
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

  private static showAuditReportDialog(table: TableDocument, report: AuditReport) {
    addon.data.dialog?.window?.close();

    const reportText = formatAuditReport(table, report);

    const dialogHelper = new ztoolkit.Dialog(1, 1)
      .addCell(
        0,
        0,
        {
          tag: "div",
          namespace: "html",
          properties: {
            innerHTML: this.renderAuditReportMarkup(table, report, reportText),
          },
          styles: {
            width: "760px",
            maxHeight: "560px",
            overflowY: "auto",
            paddingRight: "8px",
          },
        },
        false,
      )
      .addButton("Close", "close")
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

  private static renderAuditReportMarkup(
    table: TableDocument,
    report: AuditReport,
    reportText: string,
  ): string {
    const sourceLabel =
      table.source === "reader-structured-selection"
        ? getString("report-source-structured")
        : getString("report-source-text");
    const detectorMarkup = report.detectorResults
      .map((detectorResult) => {
        const tone = detectorResult.severity === "warning"
          ? { border: "#fdba74", bg: "#fff7ed", text: "#9a3412" }
          : { border: "#bfdbfe", bg: "#eff6ff", text: "#1d4ed8" };
        const findingPreview = detectorResult.findings.length
          ? `<div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">${detectorResult.findings
              .slice(0, 3)
              .map((finding) => `<div style="padding:8px 10px; border-radius:10px; background:#ffffff; border:1px solid #e2e8f0; color:#334155; line-height:1.5;">${escapeHtml(finding.message)}</div>`)
              .join("")}</div>`
          : "";
        return `<div style="border:1px solid ${tone.border}; background:${tone.bg}; border-radius:14px; padding:12px 14px;">
          <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
            <div>
              <div style="font-size:14px; font-weight:700; color:#0f172a;">${escapeHtml(humanizeDetectorId(detectorResult.detectorId))}</div>
              <div style="margin-top:4px; color:#475569; line-height:1.5;">${escapeHtml(detectorResult.summary)}</div>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
              <span style="padding:4px 8px; border-radius:999px; background:${tone.border}; color:${tone.text}; font-size:11px; font-weight:700; text-transform:uppercase;">${escapeHtml(detectorResult.severity)}</span>
              <span style="padding:4px 8px; border-radius:999px; background:#0f172a; color:#ffffff; font-size:11px; font-weight:700;">${detectorResult.findings.length}</span>
            </div>
          </div>
          ${findingPreview}
        </div>`;
      })
      .join("");
    const flattenedFindings = report.detectorResults.flatMap((detectorResult) => {
      return detectorResult.findings.map((finding) => ({
        detectorId: detectorResult.detectorId,
        message: finding.message,
      }));
    });
    const findingsMarkup = flattenedFindings.length
      ? flattenedFindings
          .map((finding) => `<div style="padding:10px 12px; border-radius:12px; background:#ffffff; border:1px solid #e2e8f0;">
            <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:0.04em;">${escapeHtml(humanizeDetectorId(finding.detectorId))}</div>
            <div style="margin-top:6px; color:#0f172a; line-height:1.55;">${escapeHtml(finding.message)}</div>
          </div>`)
          .join("")
      : `<div style="padding:12px 14px; border-radius:12px; background:#f8fafc; border:1px dashed #cbd5e1; color:#475569;">${escapeHtml(getString("report-empty-findings"))}</div>`;
    const diagnosticsMarkup = report.tableDiagnostics.length
      ? report.tableDiagnostics
          .map((diagnostic) => `<div style="padding:10px 12px; border-radius:12px; background:#fffaf0; border:1px solid #fed7aa; color:#9a3412; line-height:1.5;">${escapeHtml(diagnostic)}</div>`)
          .join("")
      : `<div style="padding:12px 14px; border-radius:12px; background:#f8fafc; border:1px dashed #cbd5e1; color:#475569;">${escapeHtml(getString("report-empty-diagnostics"))}</div>`;

    return `<div style="width:740px; font-family:'Segoe UI', 'PingFang SC', sans-serif; color:#0f172a;">
      <div style="margin-bottom:16px;">
        <div style="font-size:24px; font-weight:800; letter-spacing:-0.02em;">${escapeHtml(getString("report-dialog-title"))}</div>
        <div style="margin-top:8px; color:#475569; line-height:1.6;">${escapeHtml(report.summary)}</div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; margin-bottom:18px;">
        ${this.renderMetricCard(getString("report-card-table"), `${table.rowCount} x ${table.columnCount}`, `Page ${table.pageNumber ?? "?"}`, "#eff6ff", "#bfdbfe")}
        ${this.renderMetricCard(getString("report-card-numeric"), String(table.numericCellCount), `${table.header ? table.header.length : 0} header cell(s)`, "#ecfeff", "#a5f3fc")}
        ${this.renderMetricCard(getString("report-card-findings"), String(report.findingCount), `${report.detectorResults.filter((result) => result.findings.length).length} detector(s) flagged`, "#fff7ed", "#fdba74")}
        ${this.renderMetricCard(getString("report-card-source"), sourceLabel, table.selectionRectCount ? `${table.selectionRectCount} rect(s)` : table.attachmentKey, "#f5f3ff", "#c4b5fd")}
      </div>

      <div style="display:grid; gap:18px;">
        <section>
          <div style="font-size:14px; font-weight:800; margin-bottom:10px; text-transform:uppercase; letter-spacing:0.04em; color:#334155;">${escapeHtml(getString("report-section-diagnostics"))}</div>
          <div style="display:grid; gap:8px;">${diagnosticsMarkup}</div>
        </section>

        <section>
          <div style="font-size:14px; font-weight:800; margin-bottom:10px; text-transform:uppercase; letter-spacing:0.04em; color:#334155;">${escapeHtml(getString("report-section-detectors"))}</div>
          <div style="display:grid; gap:10px;">${detectorMarkup}</div>
        </section>

        <section>
          <div style="font-size:14px; font-weight:800; margin-bottom:10px; text-transform:uppercase; letter-spacing:0.04em; color:#334155;">${escapeHtml(getString("report-section-findings"))}</div>
          <div style="display:grid; gap:8px;">${findingsMarkup}</div>
        </section>

        <section>
          <div style="font-size:14px; font-weight:800; margin-bottom:10px; text-transform:uppercase; letter-spacing:0.04em; color:#334155;">${escapeHtml(getString("report-section-raw"))}</div>
          <pre style="margin:0; padding:14px; border-radius:14px; background:#0f172a; color:#e2e8f0; font-family:Consolas, 'Source Code Pro', monospace; font-size:12px; line-height:1.55; white-space:pre-wrap;">${escapeHtml(reportText)}</pre>
        </section>
      </div>
    </div>`;
  }

  private static renderMetricCard(
    label: string,
    value: string,
    detail: string,
    background: string,
    border: string,
  ): string {
    return `<div style="padding:12px 14px; border-radius:14px; background:${background}; border:1px solid ${border};">
      <div style="font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.05em; color:#475569;">${escapeHtml(label)}</div>
      <div style="margin-top:10px; font-size:22px; font-weight:800; color:#0f172a;">${escapeHtml(value)}</div>
      <div style="margin-top:6px; color:#475569; line-height:1.5;">${escapeHtml(detail)}</div>
    </div>`;
  }
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
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}