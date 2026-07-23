import assert from "node:assert/strict";
import test from "node:test";

import {
  countDiagnosticProducts,
  validateDiagnosticProduct,
  type DiagnosticExclusionRules,
  type RawDiagnosticProduct,
} from "../app/services/diagnostics-validation.ts";

function product(
  overrides: Partial<RawDiagnosticProduct> = {},
): RawDiagnosticProduct {
  return {
    id: "gid://shopify/Product/1",
    title: "Everyday shirt",
    description: "A complete description",
    price: "20.00",
    imageUrl: null,
    imageAlt: null,
    collectionIds: [],
    options: [
      { name: "Gender", values: ["Men"] },
      { name: "Age", values: ["Adult"] },
      { name: "Size", values: ["S", "M"] },
      { name: "Color", values: ["Black"] },
    ],
    metafields: [],
    ...overrides,
  };
}

const noExclusions: DiagnosticExclusionRules = {
  excludedCollections: [],
  excludedTitleTerms: [],
};

test("a metafield supplies an attribute missing from product options", () => {
  const diagnostic = validateDiagnosticProduct(
    product({
      options: [
        { name: "Gender", values: ["Men"] },
        { name: "Size", values: ["S", "M"] },
        { name: "Color", values: ["Black"] },
      ],
      metafields: [
        {
          namespace: "custom",
          key: "age",
          type: "single_line_text_field",
          value: "Adult",
        },
      ],
    }),
  );

  assert.equal(
    diagnostic.warnings.some((warning) => warning.code === "missing-age"),
    false,
  );
});

test("selected collection membership excludes the product", () => {
  const diagnostic = validateDiagnosticProduct(
    product({ collectionIds: ["gid://shopify/Collection/123"] }),
    {
      ...noExclusions,
      excludedCollections: [
        { id: "gid://shopify/Collection/123", title: "Summer Collection" },
      ],
    },
  );

  assert.equal(diagnostic.status, "error");
  assert.deepEqual(
    diagnostic.warnings.map((warning) => warning.message),
    ["Excluded collection: Summer Collection"],
  );
});

test("title exclusions are case-insensitive normalized substrings", () => {
  const diagnostic = validateDiagnosticProduct(
    product({ title: "  Digital   GIFT Card - $50 " }),
    { ...noExclusions, excludedTitleTerms: ["gift card"] },
  );

  assert.equal(diagnostic.status, "error");
  assert.equal(
    diagnostic.warnings[0]?.message,
    "Excluded by title term: gift card",
  );
});

test("multiple matching exclusion reasons are retained", () => {
  const diagnostic = validateDiagnosticProduct(
    product({
      title: "Sample Gift Card",
      collectionIds: ["gid://shopify/Collection/123"],
    }),
    {
      excludedCollections: [
        { id: "gid://shopify/Collection/123", title: "Clearance" },
      ],
      excludedTitleTerms: ["sample", "gift card"],
    },
  );

  assert.deepEqual(
    diagnostic.warnings.map((warning) => warning.message),
    [
      "Excluded collection: Clearance",
      "Excluded by title term: sample",
      "Excluded by title term: gift card",
    ],
  );
});

test("exclusion priority suppresses regular warning classification", () => {
  const diagnostic = validateDiagnosticProduct(
    product({
      title: "Sample item",
      options: [],
      metafields: [],
    }),
    { ...noExclusions, excludedTitleTerms: ["sample"] },
  );

  assert.equal(diagnostic.status, "error");
  assert.equal(
    diagnostic.warnings.some((warning) => warning.code === "missing-gender"),
    false,
  );
});

test("category counts remain mutually exclusive and sum to all products", () => {
  const diagnostics = [
    validateDiagnosticProduct(product({ id: "1" })),
    validateDiagnosticProduct(product({ id: "2", options: [] })),
    validateDiagnosticProduct(product({ id: "3", title: "Gift card" }), {
      ...noExclusions,
      excludedTitleTerms: ["gift card"],
    }),
  ];
  const counts = countDiagnosticProducts(diagnostics);

  assert.deepEqual(counts, {
    allProducts: 3,
    submitted: 1,
    warnings: 1,
    excluded: 1,
  });
  assert.equal(
    counts.submitted + counts.warnings + counts.excluded,
    counts.allProducts,
  );
});
