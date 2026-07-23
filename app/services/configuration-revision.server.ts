import { createHash } from "node:crypto";

import {
  normalizeConfigurationText,
  normalizeExcludedTitleTerms,
  normalizeSelectedCollections,
  type SelectedCollection,
} from "./configuration-validation.ts";

export interface DiagnosticsRevisionInput {
  colorOption?: string | null;
  excludedCollections?: SelectedCollection[] | unknown;
  excludedTitleTerms?: string[] | unknown;
  sizeOption?: string | null;
}

function normalizeOption(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = normalizeConfigurationText(value).toLocaleLowerCase();
  return normalized || null;
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
    colorOption: normalizeOption(input.colorOption),
    sizeOption: normalizeOption(input.sizeOption),
    excludedCollectionIds: collectionIds,
    excludedTitleTerms: titleTerms,
  };

  return createHash("sha256")
    .update(JSON.stringify(normalizedInput))
    .digest("hex");
}

export const EMPTY_DIAGNOSTICS_CONFIGURATION_REVISION =
  createDiagnosticsConfigurationRevision({});
