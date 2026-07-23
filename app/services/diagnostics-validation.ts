import {
  DEFAULT_COLOR_OPTIONS,
  DEFAULT_SIZE_OPTIONS,
  normalizeOptionNames,
} from "./configuration-validation.ts";

export const DIAGNOSTICS_CLASSIFICATION_VERSION =
  "diagnostics-v8-option-and-metafield-attributes";

export type DiagnosticStatus = "submitted" | "warning" | "error";

export interface DiagnosticWarning {
  code: string;
  message: string;
}

export interface RawDiagnosticProduct {
  id: string;
  title: string;
  description: string | null;
  price: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  collectionIds?: string[];
  options: Array<{
    name: string;
    values: string[];
  }>;
  metafields: Array<{
    attribute?: DiagnosticAttribute;
    namespace: string;
    key: string;
    type: string;
    value: string;
    jsonValue?: unknown;
    referencedValues?: string[];
  }>;
}

export interface DiagnosticExclusionRules {
  colorOptions?: string[];
  excludedCollections: Array<{
    id: string;
    title: string;
  }>;
  excludedTitleTerms: string[];
  sizeOptions?: string[];
}

export interface DiagnosticProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  imageAlt: string | null;
  status: DiagnosticStatus;
  warnings: DiagnosticWarning[];
}

export type DiagnosticAttribute = "gender" | "age" | "size" | "color";

const comparableAttributes: Array<{
  key: DiagnosticAttribute;
  label: string;
}> = [
  { key: "gender", label: "Gender" },
  { key: "age", label: "Age" },
  { key: "size", label: "Size" },
  { key: "color", label: "Color" },
];

const attributeAliases: Record<DiagnosticAttribute, ReadonlySet<string>> = {
  gender: new Set(["gender", "targetgender"]),
  age: new Set(["age", "agegroup", "agerange", "targetage", "targetagegroup"]),
  size: new Set([
    "size",
    "apparelsize",
    "clothingsize",
    "productsize",
    "shoesize",
  ]),
  color: new Set([
    "color",
    "colour",
    "colorpattern",
    "colourpattern",
    "productcolor",
    "productcolour",
  ]),
};

function normalizeIdentifier(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function getDiagnosticAttribute(
  value: string,
): DiagnosticAttribute | null {
  const normalized = normalizeIdentifier(value);

  for (const attribute of comparableAttributes) {
    if (attributeAliases[attribute.key].has(normalized)) {
      return attribute.key;
    }
  }

  return null;
}

function splitScalarValue(value: string) {
  return value
    .split(/[,|;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const preferredStructuredKeys = new Set([
  "amount",
  "displayname",
  "label",
  "name",
  "text",
  "value",
  "values",
]);

const ignoredStructuredKeys = new Set([
  "currencycode",
  "handle",
  "id",
  "type",
  "unit",
  "url",
]);

function flattenParsedValue(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(flattenParsedValue);
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return splitScalarValue(String(value));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    const preferredEntries = entries.filter(([key]) =>
      preferredStructuredKeys.has(normalizeIdentifier(key)),
    );
    const semanticEntries =
      preferredEntries.length > 0
        ? preferredEntries
        : entries.filter(
            ([key]) => !ignoredStructuredKeys.has(normalizeIdentifier(key)),
          );

    return semanticEntries.flatMap(([, nestedValue]) =>
      flattenParsedValue(nestedValue),
    );
  }

  return [];
}

function parseJsonValue(value: string) {
  try {
    return { parsed: true as const, value: JSON.parse(value) as unknown };
  } catch {
    return { parsed: false as const, value: undefined };
  }
}

function isReferenceType(type: string) {
  return type.toLocaleLowerCase().includes("reference");
}

function parseMetafieldValue(
  metafield: RawDiagnosticProduct["metafields"][number],
) {
  if (isReferenceType(metafield.type)) {
    return flattenParsedValue(metafield.referencedValues ?? []);
  }

  if (metafield.jsonValue !== undefined) {
    return flattenParsedValue(metafield.jsonValue);
  }

  const trimmed = metafield.value.trim();
  if (!trimmed) {
    return [];
  }

  const parsedValue = parseJsonValue(trimmed);
  if (parsedValue.parsed) {
    return flattenParsedValue(parsedValue.value);
  }

  const normalizedType = metafield.type.toLocaleLowerCase();
  if (normalizedType === "json" || normalizedType.startsWith("list.")) {
    return [];
  }

  return flattenParsedValue(trimmed);
}

function collectReferenceIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectReferenceIds);
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(collectReferenceIds);
  }

  if (
    typeof value === "string" &&
    /^gid:\/\/shopify\/[A-Za-z0-9_]+\/[^/\s]+$/.test(value.trim())
  ) {
    return [value.trim()];
  }

  return [];
}

export function getMetafieldReferenceIds(
  metafield: RawDiagnosticProduct["metafields"][number],
) {
  if (!isReferenceType(metafield.type)) {
    return [];
  }

  const parsedRawValue = parseJsonValue(metafield.value);
  const parsedValue =
    metafield.jsonValue !== undefined
      ? metafield.jsonValue
      : parsedRawValue.parsed
        ? parsedRawValue.value
        : metafield.value;

  return [...new Set(collectReferenceIds(parsedValue))];
}

function normalizeValueSet(values: string[]) {
  return new Set(
    values
      .map((value) =>
        value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase(),
      )
      .filter(Boolean),
  );
}

export function normalizeDiagnosticMatchText(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

export function getDiagnosticExclusionReasons(
  product: RawDiagnosticProduct,
  rules?: DiagnosticExclusionRules,
) {
  if (!rules) {
    return [];
  }

  const productCollectionIds = new Set(product.collectionIds ?? []);
  const reasons: DiagnosticWarning[] = [];

  for (const collection of rules.excludedCollections) {
    if (productCollectionIds.has(collection.id)) {
      reasons.push({
        code: `excluded-collection-${collection.id.split("/").at(-1)}`,
        message: `Excluded collection: ${collection.title}`,
      });
    }
  }

  const normalizedTitle = normalizeDiagnosticMatchText(product.title);
  const matchedTerms = new Set<string>();

  for (const term of rules.excludedTitleTerms) {
    const normalizedTerm = normalizeDiagnosticMatchText(term);

    if (
      normalizedTerm &&
      normalizedTitle.includes(normalizedTerm) &&
      !matchedTerms.has(normalizedTerm)
    ) {
      matchedTerms.add(normalizedTerm);
      reasons.push({
        code: `excluded-title-${matchedTerms.size}`,
        message: `Excluded by title term: ${term}`,
      });
    }
  }

  return reasons;
}

function equalSets(left: Set<string>, right: Set<string>) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function collectAttributeValues(
  product: RawDiagnosticProduct,
  source: "options" | "metafields",
  rules?: DiagnosticExclusionRules,
) {
  const values = new Map<DiagnosticAttribute, string[]>();

  if (source === "options") {
    const colorOptionNames = new Set(
      normalizeOptionNames(rules?.colorOptions ?? DEFAULT_COLOR_OPTIONS).map(
        normalizeDiagnosticMatchText,
      ),
    );
    const sizeOptionNames = new Set(
      normalizeOptionNames(rules?.sizeOptions ?? DEFAULT_SIZE_OPTIONS).map(
        normalizeDiagnosticMatchText,
      ),
    );

    for (const option of product.options) {
      const optionName = normalizeDiagnosticMatchText(option.name);
      const inferredAttribute = getDiagnosticAttribute(option.name);
      const attributes = new Set<DiagnosticAttribute>();

      if (inferredAttribute === "gender" || inferredAttribute === "age") {
        attributes.add(inferredAttribute);
      }
      if (colorOptionNames.has(optionName)) {
        attributes.add("color");
      }
      if (sizeOptionNames.has(optionName)) {
        attributes.add("size");
      }

      for (const attribute of attributes) {
        values.set(attribute, [
          ...(values.get(attribute) ?? []),
          ...option.values,
        ]);
      }
    }

    return values;
  }

  for (const metafield of product.metafields) {
    const attribute =
      metafield.attribute ?? getDiagnosticAttribute(metafield.key);

    if (attribute) {
      values.set(attribute, [
        ...(values.get(attribute) ?? []),
        ...parseMetafieldValue(metafield),
      ]);
    }
  }

  return values;
}

/**
 * Product-level validation intentionally has no Shopify dependencies. New GMC
 * warning rules and future exclusion errors can be added here without changing
 * pagination, caching, or the Diagnostics UI. Color and Size variant-option
 * aliases come from the store configuration, while a valid product metafield
 * can independently supply the same standard attribute.
 */
export function validateDiagnosticProduct(
  product: RawDiagnosticProduct,
  exclusionRules?: DiagnosticExclusionRules,
): DiagnosticProduct {
  const exclusionReasons = getDiagnosticExclusionReasons(
    product,
    exclusionRules,
  );

  if (exclusionReasons.length > 0) {
    return {
      id: product.id,
      title: product.title,
      imageUrl: product.imageUrl,
      imageAlt: product.imageAlt,
      status: "error",
      warnings: exclusionReasons,
    };
  }

  const warnings: DiagnosticWarning[] = [];
  const optionValues = collectAttributeValues(
    product,
    "options",
    exclusionRules,
  );
  const metafieldValues = collectAttributeValues(product, "metafields");

  for (const attribute of comparableAttributes) {
    const optionSet = normalizeValueSet(optionValues.get(attribute.key) ?? []);
    const metafieldSet = normalizeValueSet(
      metafieldValues.get(attribute.key) ?? [],
    );

    if (optionSet.size === 0 && metafieldSet.size === 0) {
      warnings.push({
        code: `missing-${attribute.key}`,
        message: `Missing value: ${attribute.label}.`,
      });
    } else if (
      optionSet.size > 0 &&
      metafieldSet.size > 0 &&
      !equalSets(optionSet, metafieldSet)
    ) {
      warnings.push({
        code: `mismatch-${attribute.key}`,
        message: `Mismatch detected in ${attribute.label}.`,
      });
    }
  }

  if (!product.title.trim()) {
    warnings.push({ code: "missing-title", message: "Missing value: Title." });
  }

  if (!product.description?.trim()) {
    warnings.push({
      code: "missing-description",
      message: "Missing value: Description.",
    });
  }

  if (!product.price?.trim()) {
    warnings.push({ code: "missing-price", message: "Missing value: Price." });
  }

  return {
    id: product.id,
    title: product.title,
    imageUrl: product.imageUrl,
    imageAlt: product.imageAlt,
    status: warnings.length === 0 ? "submitted" : "warning",
    warnings,
  };
}

export function countDiagnosticProducts(products: DiagnosticProduct[]) {
  let submitted = 0;
  let warnings = 0;
  let excluded = 0;

  for (const product of products) {
    if (product.status === "submitted") {
      submitted += 1;
    } else if (product.status === "warning") {
      warnings += 1;
    } else {
      excluded += 1;
    }
  }

  return {
    allProducts: products.length,
    submitted,
    warnings,
    excluded,
  };
}
