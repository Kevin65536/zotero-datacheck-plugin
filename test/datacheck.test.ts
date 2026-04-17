import { assert } from "chai";
import { buildAuditReport } from "../src/modules/datacheck/audit";
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
        extractionDiagnostics: [
          "Geometry extracted 3 visual row(s) from 6 selection rectangle(s).",
        ],
      }),
    );

    assert.equal(table.rowCount, 3);
    assert.equal(table.columnCount, 3);
    assert.deepEqual(table.header, ["Group", "Value A", "Value B"]);
    assert.equal(table.selectionRectCount, 6);
    assert.include(table.reconstructionWarnings[0], "Geometry extracted");
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

    assert.equal(report.findingCount, 3);
    assert.include(report.summary, "produced 3 finding(s)");
    assert.include(
      report.detectorResults.find(
        (result) => result.detectorId === "duplicate-numeric-sequences",
      )?.summary,
      "Detected 1 repeated numeric sequence",
    );
    assert.include(
      report.detectorResults.find(
        (result) => result.detectorId === "invalid-p-values",
      )?.findings[0].message,
      "out-of-range p-value",
    );
    assert.include(
      report.detectorResults.find(
        (result) => result.detectorId === "invalid-percentages",
      )?.findings[0].message,
      "out-of-range percentage",
    );
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

    assert.include(
      report.detectorResults.find(
        (result) => result.detectorId === "repeated-numeric-columns",
      )?.summary,
      "Detected 1 repeated numeric column pattern",
    );
    assert.include(
      report.detectorResults.find(
        (result) => result.detectorId === "uniform-numeric-columns",
      )?.findings[0].message,
      "repeats 9",
    );
  });
});