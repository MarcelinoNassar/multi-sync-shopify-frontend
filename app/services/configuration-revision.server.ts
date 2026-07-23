import { createHash } from "node:crypto";

import {
  DEFAULT_COLOR_OPTIONS,
  DEFAULT_SIZE_OPTIONS,
  normalizeConfigurationText,
  normalizeExcludedTitleTerms,
  normalizeOptionNames,
  normalizeSelectedCollections,
  type SelectedCollection,
} from "./configuration-validation.ts";

export interface DiagnosticsRevisionInput {
  colorOptions?: string[] | unknown;
  excludedCollections?: SelectedCollection[] | unknown;
  excludedTitleTerms?: string[] | unknown;
  sizeOptions?: string[] | unknown;
}

function normalizeOptions(values: unknown, defaults: readonly string[]) {
  const normalized = normalizeOptionNames(
    Array.isArray(values) ? values : defaults,
  );

  return normalized
    .map((value) => normalizeConfigurationText(value).toLocaleLowerCase())
    .sort();
}

export function createDiagnosticsConfigurationRevision(
  input: DiagnosticsRevisionInput,
) {
  const collectionIds = normalizeSelectedCollections(input.excludedCollections)
    .map(({ id }) => id)
    .sort();
  const titleTerms = normalizeExcludedTitleTerms(input.excludedTitleTerms)
    .map((term) => term.toLocaleLowerCase())
    .sort();
  const normalizedInput = {
    colorOptions: normalizeOptions(input.colorOptions, DEFAULT_COLOR_OPTIONS),
    sizeOptions: normalizeOptions(input.sizeOptions, DEFAULT_SIZE_OPTIONS),
    excludedCollectionIds: collectionIds,
    excludedTitleTerms: titleTerms,
  };

  return createHash("sha256")
    .update(JSON.stringify(normalizedInput))
    .digest("hex");
}

export const EMPTY_DIAGNOSTICS_CONFIGURATION_REVISION =
  createDiagnosticsConfigurationRevision({});
