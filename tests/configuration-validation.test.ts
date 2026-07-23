import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeExcludedTitleTerms,
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

test("configuration retains stable collection IDs and normalized store values", () => {
  const configuration = validateConfigurationInput({
    alertsEmail: " Alerts@Example.com ",
    countryCode: "lb",
    colorOption: " Colour ",
    sizeOption: "Shoe   size",
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
    colorOption: "Colour",
    sizeOption: "Shoe size",
    excludedCollections: [
      {
        id: "gid://shopify/Collection/123",
        title: "Summer Collection",
      },
    ],
    excludedTitleTerms: ["Sample"],
  });
});
