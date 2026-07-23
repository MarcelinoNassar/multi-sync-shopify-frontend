import type { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { createDiagnosticsConfigurationRevision } from "./configuration-revision.server";
import {
  DEFAULT_COLOR_OPTIONS,
  DEFAULT_SIZE_OPTIONS,
  normalizeOptionNames,
  normalizeSelectedCollections,
  resolveStoredOptionNames,
  type ConfigurationInput,
  type SelectedCollection,
  validateConfigurationInput,
} from "./configuration-validation";
import {
  queryShopifyAdmin,
  type AdminGraphQLClient,
} from "./shopify-admin.server";
import { normalizeShopDomain } from "./store-lifecycle";
import { upsertInstalledStore } from "./store.server";

const CONFIGURATION_BOOTSTRAP_QUERY = `#graphql
  query ConfigurationBootstrap {
    shop {
      contactEmail
      email
      billingAddress {
        countryCodeV2
      }
    }
  }
`;

interface ConfigurationBootstrapQuery {
  shop: {
    contactEmail: string | null;
    email: string;
    billingAddress: {
      countryCodeV2: string | null;
    };
  };
}

interface StoredConfiguration {
  alertsEmail: string;
  colorOption: string | null;
  colorOptions: string[];
  countryCode: string;
  createdAt: Date;
  diagnosticsRevision: string;
  excludedCollections: Prisma.JsonValue;
  excludedTitleTerms: string[];
  id: string;
  optionMappingsInitialized: boolean;
  sizeOption: string | null;
  sizeOptions: string[];
  storeId: string;
  updatedAt: Date;
}

export interface PublicConfiguration extends ConfigurationInput {
  id: string;
  updatedAt: string;
}

export interface DiagnosticsConfigurationRules {
  colorOptions: string[];
  excludedCollections: SelectedCollection[];
  excludedTitleTerms: string[];
  revision: string;
  sizeOptions: string[];
}

function mapConfiguration(
  configuration: StoredConfiguration,
): PublicConfiguration {
  return {
    id: configuration.id,
    alertsEmail: configuration.alertsEmail,
    countryCode: configuration.countryCode,
    colorOptions: normalizeOptionNames(configuration.colorOptions),
    sizeOptions: normalizeOptionNames(configuration.sizeOptions),
    excludedCollections: normalizeSelectedCollections(
      configuration.excludedCollections,
    ),
    excludedTitleTerms: configuration.excludedTitleTerms,
    updatedAt: configuration.updatedAt.toISOString(),
  };
}

function getStoredDiagnosticsRevision(configuration: StoredConfiguration) {
  return createDiagnosticsConfigurationRevision({
    colorOptions: configuration.colorOptions,
    excludedCollections: configuration.excludedCollections,
    excludedTitleTerms: configuration.excludedTitleTerms,
    sizeOptions: configuration.sizeOptions,
  });
}

async function ensureOptionMappings(
  configuration: StoredConfiguration,
): Promise<StoredConfiguration> {
  if (configuration.optionMappingsInitialized) {
    return configuration;
  }

  const colorOptions = resolveStoredOptionNames(
    configuration.colorOptions,
    configuration.colorOption,
    configuration.optionMappingsInitialized,
    DEFAULT_COLOR_OPTIONS,
  );
  const sizeOptions = resolveStoredOptionNames(
    configuration.sizeOptions,
    configuration.sizeOption,
    configuration.optionMappingsInitialized,
    DEFAULT_SIZE_OPTIONS,
  );

  return prisma.configuration.update({
    where: { id: configuration.id },
    data: {
      colorOption: null,
      colorOptions,
      optionMappingsInitialized: true,
      sizeOption: null,
      sizeOptions,
    },
  });
}

async function ensureDiagnosticsRevision(
  configuration: StoredConfiguration,
): Promise<StoredConfiguration> {
  const revision = getStoredDiagnosticsRevision(configuration);

  if (configuration.diagnosticsRevision === revision) {
    return configuration;
  }

  return prisma.configuration.update({
    where: { id: configuration.id },
    data: { diagnosticsRevision: revision },
  });
}

export async function getConfigurationPageData(
  admin: AdminGraphQLClient,
  session: { accessToken?: string; shop: string },
) {
  const store = await upsertInstalledStore(session);
  const existingConfiguration = await prisma.configuration.findUnique({
    where: { storeId: store.id },
  });
  let bootstrap: ConfigurationBootstrapQuery | null = null;

  try {
    bootstrap = await queryShopifyAdmin<ConfigurationBootstrapQuery>(
      admin,
      CONFIGURATION_BOOTSTRAP_QUERY,
    );
  } catch (error) {
    if (!existingConfiguration) {
      throw error;
    }
  }

  const initialConfiguration =
    existingConfiguration ??
    (await prisma.configuration.upsert({
      where: { storeId: store.id },
      update: {},
      create: {
        alertsEmail:
          bootstrap?.shop.contactEmail ?? bootstrap?.shop.email ?? "",
        countryCode:
          bootstrap?.shop.billingAddress.countryCodeV2?.toUpperCase() ?? "",
        colorOptions: [...DEFAULT_COLOR_OPTIONS],
        diagnosticsRevision: createDiagnosticsConfigurationRevision({
          colorOptions: DEFAULT_COLOR_OPTIONS,
          sizeOptions: DEFAULT_SIZE_OPTIONS,
        }),
        excludedCollections: [] as Prisma.InputJsonValue,
        excludedTitleTerms: [],
        optionMappingsInitialized: true,
        sizeOptions: [...DEFAULT_SIZE_OPTIONS],
        storeId: store.id,
      },
    }));
  const migratedConfiguration =
    await ensureOptionMappings(initialConfiguration);
  const configuration = await ensureDiagnosticsRevision(migratedConfiguration);

  return {
    configuration: mapConfiguration(configuration),
  };
}

export async function saveConfigurationForShop(
  session: { accessToken?: string; shop: string },
  value: unknown,
) {
  const input = validateConfigurationInput(value);
  const store = await upsertInstalledStore(session);
  const nextDiagnosticsRevision = createDiagnosticsConfigurationRevision(input);
  const configuration = await prisma.configuration.upsert({
    where: { storeId: store.id },
    create: {
      ...input,
      excludedCollections:
        input.excludedCollections as unknown as Prisma.InputJsonValue,
      diagnosticsRevision: nextDiagnosticsRevision,
      optionMappingsInitialized: true,
      storeId: store.id,
    },
    update: {
      ...input,
      colorOption: null,
      excludedCollections:
        input.excludedCollections as unknown as Prisma.InputJsonValue,
      diagnosticsRevision: nextDiagnosticsRevision,
      optionMappingsInitialized: true,
      sizeOption: null,
    },
  });

  return {
    configuration: mapConfiguration(configuration),
  };
}

export async function getDiagnosticsConfigurationRules(
  shop: string,
): Promise<DiagnosticsConfigurationRules> {
  const store = await prisma.store.findUnique({
    where: { shopDomain: normalizeShopDomain(shop) },
    include: { configuration: true },
  });
  let configuration = store?.configuration
    ? await ensureOptionMappings(store.configuration)
    : null;

  if (configuration) {
    const revision = createDiagnosticsConfigurationRevision({
      colorOptions: configuration.colorOptions,
      excludedCollections: configuration.excludedCollections,
      excludedTitleTerms: configuration.excludedTitleTerms,
      sizeOptions: configuration.sizeOptions,
    });

    if (configuration.diagnosticsRevision !== revision) {
      configuration = await prisma.configuration.update({
        where: { id: configuration.id },
        data: { diagnosticsRevision: revision },
      });
    }
  }

  return {
    colorOptions: normalizeOptionNames(
      configuration?.colorOptions ?? DEFAULT_COLOR_OPTIONS,
    ),
    excludedCollections: normalizeSelectedCollections(
      configuration?.excludedCollections,
    ),
    excludedTitleTerms: configuration?.excludedTitleTerms ?? [],
    revision:
      configuration?.diagnosticsRevision ??
      createDiagnosticsConfigurationRevision({}),
    sizeOptions: normalizeOptionNames(
      configuration?.sizeOptions ?? DEFAULT_SIZE_OPTIONS,
    ),
  };
}
