import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { createTableSelectionDraft, getActiveReaderContext } from "./reader";

export class DataCheckCommandFactory {
  static registerWindowMenu() {
    ztoolkit.Menu.register("menuFile", {
      tag: "menuseparator",
      id: `${config.addonRef}-menu-separator`,
    });

    ztoolkit.Menu.register("menuFile", {
      tag: "menuitem",
      id: `${config.addonRef}-menu-run-current-pdf`,
      label: getString("menuitem-filemenulabel"),
      commandListener: () => void this.runAnalyzeCurrentReaderBootstrap(),
    });
  }

  static registerPromptCommand() {
    ztoolkit.Prompt.register([
      {
        name: getString("prompt-command-name"),
        label: getString("prompt-command-label"),
        callback: () => void this.runAnalyzeCurrentReaderBootstrap(),
      },
    ]);
  }

  static async runAnalyzeCurrentReaderBootstrap() {
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
    addon.data.dataCheck.lastReaderContext = context;
    addon.data.dataCheck.lastSelectionDraft = draft;

    const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: -1,
    })
      .createLine({
        text: getString("command-draft-created"),
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
        text: getString("command-draft-selection", {
          args: { count: draft.selectedTextLength },
        }),
        type: "default",
      })
      .show();

    popupWin.startCloseTimer(6000);
  }
}