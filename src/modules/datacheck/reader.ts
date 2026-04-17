import type { ReaderAuditContext, TableSelectionDraft } from "./types";

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

  let selectedText = "";
  try {
    selectedText = ztoolkit.Reader.getSelectedText(reader) || "";
  } catch {
    selectedText = "";
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
  };
}

export function createTableSelectionDraft(
  context: ReaderAuditContext,
): TableSelectionDraft {
  return {
    source: "reader-text-selection",
    attachmentID: context.attachmentID,
    attachmentKey: context.attachmentKey,
    itemTitle: context.itemTitle,
    pageNumber: context.pageNumber,
    selectedText: context.selectedText,
    selectedTextLength: context.selectedTextLength,
    capturedAt: context.capturedAt,
  };
}