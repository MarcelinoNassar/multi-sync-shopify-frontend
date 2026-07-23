import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_COLOR_OPTIONS,
  DEFAULT_SIZE_OPTIONS,
  normalizeExcludedTitleTerms,
  normalizeOptionNames,
  resolveStoredOptionNames,
  validateConfigurationInput,
} from "../app/services/configuration-validation.ts";

test("title terms are trimmed and de-duplicated case-insensitively", () => {
  assert.deepEqual(
    normalizeExcludedTitleTerms([
      " Sample ",
      "sample",
      "Test   product",
      "",
      "Gift card",
    ]),
    ["Sample", "Test product", "Gift card"],
  );
});

test("default Color and Size mappings use standard Shopify option names", () => {
  assert.deepEqual([...DEFAULT_COLOR_OPTIONS], ["Color", "Colour"]);
  assert.deepEqual([...DEFAULT_SIZE_OPTIONS], ["Size"]);
});

test("option names are normalized and de-duplicated case-insensitively", () => {
  assert.deepEqual(
    normalizeOptionNames([" Couleur ", "couleur", "Shoe   size", "", 42]),
    ["Couleur", "Shoe size"],
  );
});

test("legacy single options migrate without overriding initialized empty arrays", () => {
  assert.deepEqual(
    resolveStoredOptionNames([], " Couleur ", false, DEFAULT_COLOR_OPTIONS),
    ["Couleur"],
  );
  assert.deepEqual(
    resolveStoredOptionNames([], null, false, DEFAULT_COLOR_OPTIONS),
    ["Color", "Colour"],
  );
  assert.deepEqual(
    resolveStoredOptionNames([], "Legacy", true, DEFAULT_COLOR_OPTIONS),
    [],
  );
});

test("configuration retains stable collection IDs and normalized store values", () => {
  const configuration = validateConfigurationInput({
    alertsEmail: " Alerts@Example.com ",
    countryCode: "lb",
    colorOptions: [" Colour ", "colour", "Taille"],
    sizeOptions: ["Shoe   size", "Taille"],
    excludedCollections: [
      {
        id: "gid://shopify/Collection/123",
        title: " Summer   Collection ",
      },
    ],
    excludedTitleTerms: [" Sample "],
  });

  assert.deepEqual(configuration, {
    alertsEmail: "alerts@example.com",
    countryCode: "LB",
    colorOptions: ["Colour", "Taille"],
    sizeOptions: ["Shoe size", "Taille"],
    excludedCollections: [
      {
        id: "gid://shopify/Collection/123",
        title: "Summer Collection",
      },
    ],
    excludedTitleTerms: ["Sample"],
  });
});
