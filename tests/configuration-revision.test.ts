import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiagnosticsConfigurationRevision,
  EMPTY_DIAGNOSTICS_CONFIGURATION_REVISION,
} from "../app/services/configuration-revision.server.ts";

test("equivalent Diagnostics settings produce the same revision", () => {
  const first = createDiagnosticsConfigurationRevision({
    colorOptions: [" Colour ", "Taille"],
    sizeOptions: ["Shoe   size", "Taille"],
    excludedCollections: [
      { id: "gid://shopify/Collection/2", title: "Second" },
      { id: "gid://shopify/Collection/1", title: "First" },
    ],
    excludedTitleTerms: [" Gift   card ", "Sample"],
  });
  const second = createDiagnosticsConfigurationRevision({
    colorOptions: ["taille", "colour"],
    sizeOptions: ["taille", "shoe size"],
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
      excludedCollections: [],
      excludedTitleTerms: [],
    }),
  );
});

test("changing an option-name mapping invalidates the Diagnostics revision", () => {
  const previous = createDiagnosticsConfigurationRevision({
    colorOptions: ["Color", "Colour"],
    sizeOptions: ["Size"],
  });
  const next = createDiagnosticsConfigurationRevision({
    colorOptions: ["Color", "Colour", "Couleur"],
    sizeOptions: ["Size"],
  });

  assert.notEqual(previous, next);
});
