const STATISTICS_CACHE_TTL_MS = 2 * 60 * 1000;
const STORE_INFORMATION_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const PAGE_SIZE = 250;

// In Shopify's product search syntax, `published_status:published` specifically
// means visible on the Online Store. Pairing it with `status:active` excludes
// drafts, archived products, and active products published only elsewhere.
const PUBLISHED_ONLINE_STORE_QUERY =
  "status:active AND published_status:published";

type CountPrecision = "EXACT" | "AT_LEAST";

interface Count {
  count: number;
  precision: CountPrecision;
}

interface ProductVariantCountNode {
  variantsCount: Count | null;
}

interface ProductVariantCountPage {
  nodes: ProductVariantCountNode[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

interface InitialStatisticsQuery {
  totalProducts: Count | null;
  publishedProducts: Count | null;
  publishedProductPage: ProductVariantCountPage;
}

interface PublishedProductsPageQuery {
  publishedProductPage: ProductVariantCountPage;
}

interface StoreInformationQuery {
  shop: {
    myshopifyDomain: string | null;
    currencyCode: string | null;
  } | null;
}

interface GraphQLError {
  message: string;
  extensions?: {
    code?: string;
  };
}

interface ThrottleStatus {
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphQLPayload<TData> {
  data?: TData;
  errors?: GraphQLError[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: ThrottleStatus;
    };
  };
}

interface AdminGraphQLClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
}

interface CacheEntry<TValue> {
  createdAt: number;
  expiresAt: number;
  value: Promise<TValue>;
}

export interface ProductStatistics {
  totalProducts: number;
  publishedProducts: number;
  publishedProductVariants: number;
  unpublishedProducts: number;
  generatedAt: string;
}

export interface StoreInformation {
  domain: string | null;
  currency: string | null;
}

const statisticsCache = new Map<string, CacheEntry<ProductStatistics>>();
const storeInformationCache = new Map<string, CacheEntry<StoreInformation>>();

const STORE_INFORMATION_QUERY = `#graphql
  query DashboardStoreInformation {
    shop {
      myshopifyDomain
      currencyCode
    }
  }
`;

const INITIAL_STATISTICS_QUERY = `#graphql
  query DashboardStatistics($publishedQuery: String!) {
    totalProducts: productsCount(limit: null) {
      count
      precision
    }
    publishedProducts: productsCount(
      limit: null
      query: $publishedQuery
    ) {
      count
      precision
    }
    publishedProductPage: products(
      first: ${PAGE_SIZE}
      query: $publishedQuery
      sortKey: ID
    ) {
      nodes {
        variantsCount {
          count
          precision
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PUBLISHED_PRODUCTS_PAGE_QUERY = `#graphql
  query DashboardPublishedProductPage(
    $after: String!
    $publishedQuery: String!
  ) {
    publishedProductPage: products(
      first: ${PAGE_SIZE}
      after: $after
      query: $publishedQuery
      sortKey: ID
    ) {
      nodes {
        variantsCount {
          count
          precision
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

class DashboardDataError extends Error {
  constructor() {
    super("We couldn't load the requested dashboard data from Shopify.");
    this.name = "DashboardDataError";
  }
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function throttleDelay(payload: GraphQLPayload<unknown>) {
  const cost = payload.extensions?.cost;
  const throttle = cost?.throttleStatus;
  const requestedCost = cost?.requestedQueryCost ?? 1;

  if (!throttle || throttle.currentlyAvailable >= requestedCost) {
    return 0;
  }

  return Math.ceil(
    ((requestedCost - throttle.currentlyAvailable) /
      Math.max(throttle.restoreRate, 1)) *
      1000,
  );
}

async function queryShopify<TData>(
  admin: AdminGraphQLClient,
  query: string,
  variables: Record<string, unknown> = {},
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await admin.graphql(query, { variables });
    const payload = (await response.json()) as GraphQLPayload<TData>;
    const wasThrottled =
      response.status === 429 ||
      payload.errors?.some((error) => error.extensions?.code === "THROTTLED");

    if (wasThrottled && attempt < 2) {
      const retryAfterSeconds = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : Math.max(throttleDelay(payload), 500 * (attempt + 1));

      await wait(delay);
      continue;
    }

    if (!response.ok || payload.errors?.length || !payload.data) {
      throw new DashboardDataError();
    }

    return payload;
  }

  throw new DashboardDataError();
}

function assertExactCount(count: Count | null): asserts count is Count {
  if (!count || count.precision !== "EXACT") {
    throw new DashboardDataError();
  }
}

function addVariantCounts(page: ProductVariantCountPage) {
  return page.nodes.reduce((total, product) => {
    assertExactCount(product.variantsCount);
    return total + product.variantsCount.count;
  }, 0);
}

async function fetchStoreInformation(
  admin: AdminGraphQLClient,
): Promise<StoreInformation> {
  const payload = await queryShopify<StoreInformationQuery>(
    admin,
    STORE_INFORMATION_QUERY,
  );
  const shop = payload.data?.shop;

  return {
    domain: shop?.myshopifyDomain ?? null,
    currency: shop?.currencyCode ?? null,
  };
}

async function fetchProductStatistics(
  admin: AdminGraphQLClient,
): Promise<ProductStatistics> {
  const initialPayload = await queryShopify<InitialStatisticsQuery>(
    admin,
    INITIAL_STATISTICS_QUERY,
    { publishedQuery: PUBLISHED_ONLINE_STORE_QUERY },
  );
  const initial = initialPayload.data;

  if (!initial) {
    throw new DashboardDataError();
  }

  assertExactCount(initial.totalProducts);
  assertExactCount(initial.publishedProducts);

  let publishedProductVariants = addVariantCounts(initial.publishedProductPage);
  let pageInfo = initial.publishedProductPage.pageInfo;
  let previousPayload: GraphQLPayload<unknown> = initialPayload;

  while (pageInfo.hasNextPage) {
    if (!pageInfo.endCursor) {
      throw new DashboardDataError();
    }

    const delay = throttleDelay(previousPayload);
    if (delay > 0) {
      await wait(delay);
    }

    const pagePayload = await queryShopify<PublishedProductsPageQuery>(
      admin,
      PUBLISHED_PRODUCTS_PAGE_QUERY,
      {
        after: pageInfo.endCursor,
        publishedQuery: PUBLISHED_ONLINE_STORE_QUERY,
      },
    );
    const page = pagePayload.data?.publishedProductPage;

    if (!page) {
      throw new DashboardDataError();
    }

    publishedProductVariants += addVariantCounts(page);
    pageInfo = page.pageInfo;
    previousPayload = pagePayload;
  }

  const totalProducts = initial.totalProducts.count;
  const publishedProducts = initial.publishedProducts.count;

  if (publishedProducts > totalProducts) {
    throw new DashboardDataError();
  }

  return {
    totalProducts,
    publishedProducts,
    publishedProductVariants,
    unpublishedProducts: totalProducts - publishedProducts,
    generatedAt: new Date().toISOString(),
  };
}

function pruneCache<TValue>(
  cache: Map<string, CacheEntry<TValue>>,
  now: number,
) {
  for (const [shop, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(shop);
    }
  }

  if (cache.size < MAX_CACHE_ENTRIES) {
    return;
  }

  const oldestEntry = [...cache.entries()].sort(
    ([, left], [, right]) => left.createdAt - right.createdAt,
  )[0];

  if (oldestEntry) {
    cache.delete(oldestEntry[0]);
  }
}

function getCachedValue<TValue>(
  cache: Map<string, CacheEntry<TValue>>,
  shop: string,
  ttlMilliseconds: number,
  fetchValue: () => Promise<TValue>,
) {
  const cacheKey = shop.trim().toLowerCase();
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  pruneCache(cache, now);

  const value = fetchValue();
  const entry: CacheEntry<TValue> = {
    createdAt: now,
    expiresAt: now + ttlMilliseconds,
    value,
  };

  cache.set(cacheKey, entry);

  value.catch(() => {
    if (cache.get(cacheKey) === entry) {
      cache.delete(cacheKey);
    }
  });

  return value;
}

export function getStoreInformation(admin: AdminGraphQLClient, shop: string) {
  return getCachedValue(
    storeInformationCache,
    shop,
    STORE_INFORMATION_CACHE_TTL_MS,
    () => fetchStoreInformation(admin),
  );
}

export function getProductStatistics(admin: AdminGraphQLClient, shop: string) {
  return getCachedValue(statisticsCache, shop, STATISTICS_CACHE_TTL_MS, () =>
    fetchProductStatistics(admin),
  );
}

export function invalidateDashboardCache(shop: string) {
  const cacheKey = shop.trim().toLowerCase();
  statisticsCache.delete(cacheKey);
  storeInformationCache.delete(cacheKey);
}
