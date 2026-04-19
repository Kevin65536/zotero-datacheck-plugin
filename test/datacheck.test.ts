import { assert } from "chai";
import { buildAuditReport } from "../src/modules/datacheck/audit";
import {
  appendSelectionPopupAnalyzeButton,
  buildReportVisualizationModel,
} from "../src/modules/datacheck/commands";
import { parseNumericValue, parseTableSelection } from "../src/modules/datacheck/parser";
import type { TableSelectionDraft } from "../src/modules/datacheck/types";

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
    assert.include(table.reconstructionWarnings, "structured-selection-ready");
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
          ...Array.from({ length: 20 }, (_, index) => `R${index + 1}\t9${index + 10}`),
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
});

describe("datacheck selection popup", function () {
  it("keeps a single analyze button when the popup renders repeatedly", function () {
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument(
      "datacheck-selection-popup",
    );
    const container = doc.createElement("div");
    doc.body.append(container);

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