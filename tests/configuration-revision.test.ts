import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiagnosticsConfigurationRevision,
  EMPTY_DIAGNOSTICS_CONFIGURATION_REVISION,
} from "../app/services/configuration-revision.server.ts";

test("equivalent Diagnostics settings produce the same revision", () => {
  const first = createDiagnosticsConfigurationRevision({
    colorOption: " Colour ",
    sizeOption: "Shoe   size",
    excludedCollections: [
      { id: "gid://shopify/Collection/2", title: "Second" },
      { id: "gid://shopify/Collection/1", title: "First" },
    ],
    excludedTitleTerms: [" Gift   card ", "Sample"],
  });
  const second = createDiagnosticsConfigurationRevision({
    colorOption: "colour",
    sizeOption: "shoe size",
    excludedCollections: [
      { id: "gid://shopify/Collection/1", title: "Renamed First" },
      { id: "gid://shopify/Collection/2", title: "Second" },
    ],
    excludedTitleTerms: ["sample", "gift card"],
  });

  assert.equal(first, second);
});

test("a Diagnostics-affecting change produces a new revision", () => {
  const previous = createDiagnosticsConfigurationRevision({
    excludedTitleTerms: ["Sample"],
  });
  const next = createDiagnosticsConfigurationRevision({
    excludedTitleTerms: ["Sample", "Gift card"],
  });

  assert.notEqual(previous, next);
});

test("the empty Diagnostics revision is stable", () => {
  assert.equal(
    EMPTY_DIAGNOSTICS_CONFIGURATION_REVISION,
    createDiagnosticsConfigurationRevision({
      colorOption: null,
      sizeOption: null,
      excludedCollections: [],
      excludedTitleTerms: [],
    }),
  );
});
