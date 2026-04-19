import { assert } from "chai";
import { config } from "../package.json";
import { getString } from "../src/utils/locale";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("should not record startup errors", function () {
    assert.isUndefined(
      Zotero[config.addonInstance].data.startupError,
      Zotero[config.addonInstance].data.startupError,
    );
  });

  it("should resolve localized strings", function () {
    assert.notEqual(
      getString("selection-popup-analyze-label"),
      `${config.addonRef}-selection-popup-analyze-label`,
    );
    assert.notEqual(
      getString("report-dialog-close"),
      `${config.addonRef}-report-dialog-close`,
    );
  });
});
