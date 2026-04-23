import { DataCheckCommandFactory } from "./modules/datacheck/commands";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

function registerPreferencePane() {
  const preferencePanes = (Zotero as any).PreferencePanes;
  if (!preferencePanes?.register) {
    return;
  }

  preferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: `${rootURI}content/preferences.xhtml`,
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`,
  });
}

function unregisterPreferencePane() {
  const preferencePanes = (Zotero as any).PreferencePanes;
  preferencePanes?.unregister?.(addon.data.config.addonID);
}

async function onStartup() {
  try {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);

    initLocale();
    registerPreferencePane();
    addon.api = {
      ...addon.api,
      runAnalyzeCurrentReader: () =>
        void DataCheckCommandFactory.runAnalyzeCurrentReader(),
    };
    DataCheckCommandFactory.registerReaderIntegration();

    await Promise.all(
      Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
    );
  } catch (error) {
    const startupError =
      error instanceof Error ? error : new Error(String(error));
    addon.data.startupError = startupError.stack ?? startupError.message;
    Zotero.logError(startupError);
  } finally {
    addon.data.initialized = true;
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  DataCheckCommandFactory.registerPromptCommand();
  DataCheckCommandFactory.registerWindowMenu(win);

  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString("startup-begin"),
      type: "default",
      progress: 30,
    })
    .show();

  await Zotero.Promise.delay(250);

  popupWin.changeLine({
    progress: 100,
    text: getString("startup-finish"),
  });
  popupWin.startCloseTimer(2500);
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  DataCheckCommandFactory.unregisterWindowMenu(_win);
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  unregisterPreferencePane();
  DataCheckCommandFactory.unregisterReaderIntegration();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(_type: string) {}

function onDialogEvents(_type: string) {}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
