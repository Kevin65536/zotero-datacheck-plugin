import { assert } from "chai";
import { config } from "../package.json";

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
});
