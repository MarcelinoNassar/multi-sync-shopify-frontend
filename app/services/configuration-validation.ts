export interface SelectedCollection {
  id: string;
  title: string;
}

export interface ConfigurationInput {
  alertsEmail: string;
  countryCode: string;
  colorOption: string | null;
  sizeOption: string | null;
  excludedCollections: SelectedCollection[];
  excludedTitleTerms: string[];
}

export interface ConfigurationFieldErrors {
  alertsEmail?: string;
  countryCode?: string;
  colorOption?: string;
  sizeOption?: string;
  excludedCollections?: string;
  excludedTitleTerms?: string;
}

export class ConfigurationValidationError extends Error {
  readonly fields: ConfigurationFieldErrors;

  constructor(fields: ConfigurationFieldErrors) {
    super("Correct the highlighted configuration fields and try again.");
    this.name = "ConfigurationValidationError";
    this.fields = fields;
  }
}

const SHOPIFY_COLLECTION_ID = /^gid:\/\/shopify\/Collection\/\d+$/;
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_COLLECTIONS = 100;
const MAX_TITLE_TERMS = 100;

export function normalizeConfigurationText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function optionalText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = normalizeConfigurationText(value);
  return normalized ? normalized.slice(0, maximumLength) : null;
}

export function normalizeExcludedTitleTerms(values: unknown) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const normalizedTerms: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const term = normalizeConfigurationText(value).slice(0, 100);
    const comparable = term.toLocaleLowerCase();

    if (!term || seen.has(comparable)) {
      continue;
    }

    seen.add(comparable);
    normalizedTerms.push(term);
  }

  return normalizedTerms;
}

export function normalizeSelectedCollections(values: unknown) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const collections: SelectedCollection[] = [];

  for (const value of values) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof value.id !== "string" ||
      typeof value.title !== "string"
    ) {
      continue;
    }

    const id = value.id.trim();
    const title = normalizeConfigurationText(value.title).slice(0, 255);

    if (!SHOPIFY_COLLECTION_ID.test(id) || !title || seen.has(id)) {
      continue;
    }

    seen.add(id);
    collections.push({ id, title });
  }

  return collections;
}

export function validateConfigurationInput(value: unknown): ConfigurationInput {
  const fields: ConfigurationFieldErrors = {};
  const input: Record<string, unknown> =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const alertsEmail =
    typeof input.alertsEmail === "string"
      ? normalizeConfigurationText(input.alertsEmail).toLocaleLowerCase()
      : "";
  const countryCode =
    typeof input.countryCode === "string"
      ? normalizeConfigurationText(input.countryCode).toUpperCase()
      : "";
  const colorOption = optionalText(input.colorOption, 100);
  const sizeOption = optionalText(input.sizeOption, 100);
  const excludedCollections = normalizeSelectedCollections(
    input.excludedCollections,
  );
  const excludedTitleTerms = normalizeExcludedTitleTerms(
    input.excludedTitleTerms,
  );

  if (!EMAIL_ADDRESS.test(alertsEmail) || alertsEmail.length > 254) {
    fields.alertsEmail = "Enter a valid email address.";
  }

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    fields.countryCode = "Enter a two-letter country code.";
  }

  if (
    input.colorOption !== null &&
    input.colorOption !== undefined &&
    typeof input.colorOption !== "string"
  ) {
    fields.colorOption = "Select a valid color option.";
  }

  if (
    input.sizeOption !== null &&
    input.sizeOption !== undefined &&
    typeof input.sizeOption !== "string"
  ) {
    fields.sizeOption = "Select a valid size option.";
  }

  if (
    Array.isArray(input.excludedCollections) &&
    input.excludedCollections.length > MAX_COLLECTIONS
  ) {
    fields.excludedCollections = `Select no more than ${MAX_COLLECTIONS} collections.`;
  } else if (
    Array.isArray(input.excludedCollections) &&
    excludedCollections.length !== input.excludedCollections.length
  ) {
    fields.excludedCollections =
      "One or more selected collections are invalid.";
  }

  if (
    Array.isArray(input.excludedTitleTerms) &&
    input.excludedTitleTerms.length > MAX_TITLE_TERMS
  ) {
    fields.excludedTitleTerms = `Add no more than ${MAX_TITLE_TERMS} title terms.`;
  } else if (
    Array.isArray(input.excludedTitleTerms) &&
    input.excludedTitleTerms.some(
      (term) => typeof term !== "string" || !normalizeConfigurationText(term),
    )
  ) {
    fields.excludedTitleTerms = "Remove empty product-title terms.";
  }

  if (Object.keys(fields).length > 0) {
    throw new ConfigurationValidationError(fields);
  }

  return {
    alertsEmail,
    countryCode,
    colorOption,
    sizeOption,
    excludedCollections,
    excludedTitleTerms,
  };
}
