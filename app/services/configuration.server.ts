import type { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { createDiagnosticsConfigurationRevision } from "./configuration-revision.server";
import {
  normalizeSelectedCollections,
  type ConfigurationInput,
  type SelectedCollection,
  validateConfigurationInput,
} from "./configuration-validation";
import {
  queryShopifyAdmin,
  type AdminGraphQLClient,
} from "./shopify-admin.server";
import { findReadyDiagnosticsSnapshot } from "./diagnostics-snapshot.server";
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
    products(first: 100, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        options {
          name
        }
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
  products: {
    nodes: Array<{
      options: Array<{ name: string }>;
    }>;
  };
}

interface StoredConfiguration {
  alertsEmail: string;
  colorOption: string | null;
  countryCode: string;
  createdAt: Date;
  diagnosticsRevision: string;
  excludedCollections: Prisma.JsonValue;
  excludedTitleTerms: string[];
  id: string;
  sizeOption: string | null;
  storeId: string;
  updatedAt: Date;
}

export interface PublicConfiguration extends ConfigurationInput {
  id: string;
  updatedAt: string;
}

export interface DiagnosticsConfigurationRules {
  excludedCollections: SelectedCollection[];
  excludedTitleTerms: string[];
  revision: string;
}

function mapConfiguration(
  configuration: StoredConfiguration,
): PublicConfiguration {
  return {
    id: configuration.id,
    alertsEmail: configuration.alertsEmail,
    countryCode: configuration.countryCode,
    colorOption: configuration.colorOption,
    sizeOption: configuration.sizeOption,
    excludedCollections: normalizeSelectedCollections(
      configuration.excludedCollections,
    ),
    excludedTitleTerms: configuration.excludedTitleTerms,
    updatedAt: configuration.updatedAt.toISOString(),
  };
}

function getStoredDiagnosticsRevision(configuration: StoredConfiguration) {
  return createDiagnosticsConfigurationRevision({
    colorOption: configuration.colorOption,
    excludedCollections: configuration.excludedCollections,
    excludedTitleTerms: configuration.excludedTitleTerms,
    sizeOption: configuration.sizeOption,
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

function collectOptionNames(data: ConfigurationBootstrapQuery) {
  const names = new Map<string, string>();

  for (const product of data.products.nodes) {
    for (const option of product.options) {
      const name = option.name.normalize("NFKC").trim().replace(/\s+/g, " ");
      const key = name.toLocaleLowerCase();

      if (name && !names.has(key)) {
        names.set(key, name);
      }
    }
  }

  return [...names.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
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

  const storedConfiguration =
    existingConfiguration ??
    (await prisma.configuration.upsert({
      where: { storeId: store.id },
      update: {},
      create: {
        alertsEmail:
          bootstrap?.shop.contactEmail ?? bootstrap?.shop.email ?? "",
        countryCode:
          bootstrap?.shop.billingAddress.countryCodeV2?.toUpperCase() ?? "",
        diagnosticsRevision: createDiagnosticsConfigurationRevision({}),
        excludedCollections: [] as Prisma.InputJsonValue,
        excludedTitleTerms: [],
        storeId: store.id,
      },
    }));
  const configuration = await ensureDiagnosticsRevision(storedConfiguration);

  return {
    configuration: mapConfiguration(configuration),
    optionNames: bootstrap ? collectOptionNames(bootstrap) : [],
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
      storeId: store.id,
    },
    update: {
      ...input,
      excludedCollections:
        input.excludedCollections as unknown as Prisma.InputJsonValue,
      diagnosticsRevision: nextDiagnosticsRevision,
    },
  });
  const latestDiagnosticsSnapshot = await findReadyDiagnosticsSnapshot(
    session.shop,
  ).catch((error) => {
    console.error(
      "Unable to compare the saved configuration with Diagnostics",
      error,
    );
    return null;
  });
  const diagnosticsRequiresRefresh =
    !latestDiagnosticsSnapshot ||
    latestDiagnosticsSnapshot.configurationRevision !== nextDiagnosticsRevision;

  return {
    configuration: mapConfiguration(configuration),
    diagnosticsRequiresRefresh,
  };
}

export async function getDiagnosticsConfigurationRules(
  shop: string,
): Promise<DiagnosticsConfigurationRules> {
  const store = await prisma.store.findUnique({
    where: { shopDomain: normalizeShopDomain(shop) },
    select: {
      configuration: {
        select: {
          excludedCollections: true,
          excludedTitleTerms: true,
          colorOption: true,
          diagnosticsRevision: true,
          id: true,
          sizeOption: true,
        },
      },
    },
  });
  let configuration = store?.configuration;

  if (configuration) {
    const revision = createDiagnosticsConfigurationRevision({
      colorOption: configuration.colorOption,
      excludedCollections: configuration.excludedCollections,
      excludedTitleTerms: configuration.excludedTitleTerms,
      sizeOption: configuration.sizeOption,
    });

    if (configuration.diagnosticsRevision !== revision) {
      configuration = await prisma.configuration.update({
        where: { id: configuration.id },
        data: { diagnosticsRevision: revision },
        select: {
          colorOption: true,
          diagnosticsRevision: true,
          excludedCollections: true,
          excludedTitleTerms: true,
          id: true,
          sizeOption: true,
        },
      });
    }
  }

  return {
    excludedCollections: normalizeSelectedCollections(
      configuration?.excludedCollections,
    ),
    excludedTitleTerms: configuration?.excludedTitleTerms ?? [],
    revision:
      configuration?.diagnosticsRevision ??
      createDiagnosticsConfigurationRevision({}),
  };
}
