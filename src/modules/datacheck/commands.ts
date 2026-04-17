import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { buildAuditReport, formatAuditReport } from "./audit";
import { parseTableSelection } from "./parser";
import { createTableSelectionDraft, getActiveReaderContext } from "./reader";

const FILE_MENU_SEPARATOR_ID = `${config.addonRef}-file-menu-separator`;
const FILE_MENU_ITEM_ID = `${config.addonRef}-file-menu-item`;

export class DataCheckCommandFactory {
  static registerWindowMenu(win: Window) {
    this.unregisterWindowMenu(win);

    const fileMenuPopup = win.document.querySelector(
      "#menu_FilePopup",
    ) as XULPopupElement | null;
    if (!fileMenuPopup) {
      return;
    }

    try {
      const separator = win.document.createXULElement("menuseparator");
      separator.id = FILE_MENU_SEPARATOR_ID;

      const menuItem = win.document.createXULElement("menuitem");
      menuItem.id = FILE_MENU_ITEM_ID;
      menuItem.setAttribute("label", getString("menuitem-filemenulabel"));
      menuItem.addEventListener("command", () => {
        void this.runAnalyzeCurrentReader();
      });

      fileMenuPopup.append(separator, menuItem);
    } catch (error) {
      const menuError = error instanceof Error ? error : new Error(String(error));
      Zotero.logError(menuError);
    }
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
    this.showAuditReportDialog(formatAuditReport(table, report), report.summary);
  }

  private static showAuditReportDialog(reportText: string, summary: string) {
    addon.data.dialog?.window?.close();

    const dialogHelper = new ztoolkit.Dialog(3, 1)
      .addCell(0, 0, {
        tag: "h2",
        properties: { innerHTML: getString("report-dialog-title") },
      })
      .addCell(1, 0, {
        tag: "p",
        properties: { innerHTML: summary },
        styles: {
          width: "680px",
        },
      })
      .addCell(
        2,
        0,
        {
          tag: "textarea",
          namespace: "html",
          attributes: {
            readonly: "true",
          },
          properties: {
            value: reportText,
          },
          styles: {
            width: "680px",
            height: "360px",
            fontFamily: "Consolas, 'Source Code Pro', monospace",
            fontSize: "12px",
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
}