export interface ReaderAuditContext {
  attachmentID: number;
  attachmentKey: string;
  itemTitle: string;
  pageNumber?: number;
  selectedText: string;
  selectedTextLength: number;
  capturedAt: string;
}

export interface TableSelectionDraft {
  source: "reader-bootstrap";
  attachmentID: number;
  attachmentKey: string;
  itemTitle: string;
  pageNumber?: number;
  selectedText: string;
  selectedTextLength: number;
  capturedAt: string;
}