import { normalizeOptionNames } from "./configuration-validation.ts";
import {
  ShopifyAdminQueryError,
  type AdminGraphQLClient,
} from "./shopify-admin.server.ts";
import { normalizeShopDomain } from "./store-lifecycle.ts";

const SHOPIFY_PRODUCT_BATCH_SIZE = 250;
const OPTION_NAMES_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHED_SHOPS = 250;
const MAX_THROTTLE_RETRIES = 5;

const PRODUCT_OPTION_NAMES_QUERY = `#graphql
  query ConfigurationProductOptionNames($after: String, $first: Int!) {
    products(after: $after, first: $first) {
      nodes {
        options {
          name
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

interface ProductOptionNamesQuery {
  products: {
    nodes: Array<{
      options: Array<{ name: string }>;
    }>;
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
    };
  };
}

interface ShopifyGraphQLError {
  extensions?: {
    code?: string;
  };
  message: string;
}

interface ShopifyGraphQLPayload<TData> {
  data?: TData;
  errors?: ShopifyGraphQLError[];
  extensions?: {
    cost?: {
      actualQueryCost?: number;
      requestedQueryCost?: number;
      throttleStatus?: {
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

interface OptionNamesCacheEntry {
  expiresAt: number;
  value: Promise<string[]>;
}

const optionNamesCache = new Map<string, OptionNamesCacheEntry>();

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function throttleDelay(payload: ShopifyGraphQLPayload<unknown>) {
  const cost = payload.extensions?.cost;
  const throttleStatus = cost?.throttleStatus;

  if (!cost || !throttleStatus || throttleStatus.restoreRate <= 0) {
    return 0;
  }

  const nextRequestCost =
    cost.requestedQueryCost ??
    cost.actualQueryCost ??
    SHOPIFY_PRODUCT_BATCH_SIZE;
  const deficit = Math.max(
    0,
    nextRequestCost - throttleStatus.currentlyAvailable,
  );

  return deficit > 0
    ? Math.min(10_000, Math.ceil((deficit / throttleStatus.restoreRate) * 1000))
    : 0;
}

async function queryOptionNamesPage(
  admin: AdminGraphQLClient,
  after: string | null,
) {
  let attempt = 0;

  while (attempt <= MAX_THROTTLE_RETRIES) {
    const response = await admin.graphql(PRODUCT_OPTION_NAMES_QUERY, {
      variables: {
        after,
        first: SHOPIFY_PRODUCT_BATCH_SIZE,
      },
    });
    const payload =
      (await response.json()) as ShopifyGraphQLPayload<ProductOptionNamesQuery>;
    const throttled = payload.errors?.some(
      (error) => error.extensions?.code === "THROTTLED",
    );

    if (response.ok && !payload.errors?.length && payload.data?.products) {
      return payload;
    }

    if (!throttled || attempt === MAX_THROTTLE_RETRIES) {
      throw new ShopifyAdminQueryError(
        "Shopify did not return product option names.",
      );
    }

    attempt += 1;
    await wait(Math.max(250, throttleDelay(payload)));
  }

  throw new ShopifyAdminQueryError(
    "Shopify did not return product option names.",
  );
}

async function discoverShopVariantOptionNames(admin: AdminGraphQLClient) {
  const names: string[] = [];
  let after: string | null = null;
  let hasNextPage = true;
  let previousPayload: ShopifyGraphQLPayload<unknown> | null = null;

  while (hasNextPage) {
    if (previousPayload) {
      const delay = throttleDelay(previousPayload);
      if (delay > 0) {
        await wait(delay);
      }
    }

    const payload = await queryOptionNamesPage(admin, after);
    const connection = payload.data?.products;

    if (!connection) {
      throw new ShopifyAdminQueryError(
        "Shopify did not return product option names.",
      );
    }

    for (const product of connection.nodes) {
      for (const option of product.options) {
        names.push(option.name);
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    if (!hasNextPage) {
      break;
    }

    if (!connection.pageInfo.endCursor) {
      throw new ShopifyAdminQueryError(
        "Shopify returned incomplete option-name pagination.",
      );
    }

    after = connection.pageInfo.endCursor;
    previousPayload = payload;
  }

  return normalizeOptionNames(names).sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

function pruneOptionNamesCache() {
  const now = Date.now();

  for (const [shop, entry] of optionNamesCache) {
    if (entry.expiresAt <= now) {
      optionNamesCache.delete(shop);
    }
  }

  while (optionNamesCache.size >= MAX_CACHED_SHOPS) {
    const oldestShop = optionNamesCache.keys().next().value;
    if (!oldestShop) {
      break;
    }
    optionNamesCache.delete(oldestShop);
  }
}

export function getShopVariantOptionNames(
  admin: AdminGraphQLClient,
  shop: string,
) {
  const normalizedShop = normalizeShopDomain(shop);
  const cached = optionNamesCache.get(normalizedShop);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (cached) {
    optionNamesCache.delete(normalizedShop);
  }

  pruneOptionNamesCache();
  const value = discoverShopVariantOptionNames(admin).catch((error) => {
    const current = optionNamesCache.get(normalizedShop);
    if (current?.value === value) {
      optionNamesCache.delete(normalizedShop);
    }
    throw error;
  });

  optionNamesCache.set(normalizedShop, {
    expiresAt: Date.now() + OPTION_NAMES_CACHE_TTL_MS,
    value,
  });

  return value;
}

export function clearShopVariantOptionNamesCache(shop?: string) {
  if (shop) {
    optionNamesCache.delete(normalizeShopDomain(shop));
  } else {
    optionNamesCache.clear();
  }
}
