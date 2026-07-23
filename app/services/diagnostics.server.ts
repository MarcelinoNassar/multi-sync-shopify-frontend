import { randomUUID } from "node:crypto";

import { ACTIVE_ONLINE_STORE_PRODUCT_QUERY } from "./catalog-query";
import { normalizeDiagnosticsSearch } from "./diagnostics-search";
import {
  appendDiagnosticsSnapshotProducts,
  beginDiagnosticsSnapshot,
  completeDiagnosticsSnapshot,
  decodeDiagnosticsSnapshotCursor,
  discardDiagnosticsSnapshot,
  encodeDiagnosticsSnapshotCursor,
  findReadyDiagnosticsSnapshot,
  readDiagnosticsSnapshotPage,
} from "./diagnostics-snapshot.server";
import {
  DIAGNOSTICS_CLASSIFICATION_VERSION,
  getDiagnosticAttribute,
  getMetafieldReferenceIds,
  validateDiagnosticProduct,
  type DiagnosticAttribute,
  type DiagnosticProduct,
  type DiagnosticStatus,
  type RawDiagnosticProduct,
} from "./diagnostics-validation";

// Store-wide counts are deliberately longer lived than table pages. The
// client keeps them for the current app session, while this server cache also
// coalesces requests across reloads and app instances handled by this process.
// An explicit Diagnostics refresh invalidates this value immediately.
const COUNTS_CACHE_TTL_MS = 15 * 60 * 1000;
const PAGE_CACHE_TTL_MS = 60 * 1000;
const RAW_PRODUCT_PAGE_CACHE_TTL_MS = 2 * 60 * 1000;
const METAFIELD_KEYS_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
// Raw Shopify batches are only a short coalescing window. Capping this cache
// prevents a complete large catalog from being retained in server memory.
const MAX_RAW_PRODUCT_PAGE_CACHE_ENTRIES = 8;
const TABLE_PAGE_SIZE = 25;
const MAX_METAFIELD_KEYS = 64;
const MAX_REFERENCE_IDS_PER_REQUEST = 250;
const MIN_SHOPIFY_SCAN_BATCH_SIZE = 25;
const MAX_SHOPIFY_SCAN_BATCH_SIZE = 250;
// Shopify currently enforces a single-query cost ceiling. Staying below that
// ceiling leaves headroom for fields whose defined cost changes between API
// versions and for stores with more expensive nested metafield data.
const TARGET_SHOPIFY_QUERY_COST = 800;
const SHOPIFY_SCAN_VERSION_PREFIX = `shopify-${DIAGNOSTICS_CLASSIFICATION_VERSION}:`;

const fallbackMetafieldKeys = [
  "gender",
  "target-gender",
  "target_gender",
  "age",
  "age_group",
  "age-group",
  "age_range",
  "age-range",
  "target-age",
  "size",
  "color",
  "colour",
  "color-pattern",
  "colour-pattern",
].flatMap((key) =>
  ["custom", "google", "shopify"].map((namespace) => `${namespace}.${key}`),
);

export type DiagnosticsTab = "all" | "submitted" | "warnings" | "excluded";

export interface DiagnosticsCounts {
  allProducts: number;
  submitted: number;
  warnings: number;
  excluded: number;
  generatedAt: string;
  scanVersion: string;
}

export interface DiagnosticsPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface DiagnosticsPage {
  products: DiagnosticProduct[];
  pageInfo: DiagnosticsPageInfo;
  scanVersion: string;
}

interface DiagnosticsPageOptions {
  tab: DiagnosticsTab;
  after?: string | null;
  before?: string | null;
  force?: boolean;
  refreshToken?: string | null;
  search?: string | null;
  snapshotVersion?: string | null;
}

interface DiagnosticsCountsOptions {
  force?: boolean;
  refreshToken?: string | null;
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
      actualQueryCost?: number;
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
  settled: boolean;
  value: Promise<TValue>;
}

interface MetafieldDefinitionQuery {
  metafieldDefinitions: {
    nodes: Array<{
      name: string;
      namespace: string;
      key: string;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

interface ProductEdge {
  cursor: string;
  node: {
    id: string;
    title: string;
    description: string | null;
    featuredMedia: {
      preview: {
        image: {
          url: string;
          altText: string | null;
        } | null;
      } | null;
    } | null;
    priceRangeV2: {
      minVariantPrice: {
        amount: string;
      } | null;
    } | null;
    options: Array<{
      name: string;
      values: string[];
    }>;
    metafields: {
      nodes: Array<{
        namespace: string;
        key: string;
        type: string;
        value: string;
        jsonValue: unknown;
      }>;
    };
  };
}

interface ProductPageQuery {
  products: {
    edges: ProductEdge[];
    pageInfo: {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      startCursor: string | null;
      endCursor: string | null;
    };
  };
}

interface RawProductPage {
  page: ProductPageQuery["products"];
  payload: GraphQLPayload<ProductPageQuery>;
}

interface DiagnosticMetafieldSelection {
  keys: string[];
  attributesByIdentifier: ReadonlyMap<string, DiagnosticAttribute>;
}

interface MetafieldReferenceNode {
  __typename: string;
  id: string;
  displayName?: string;
  name?: string;
}

interface MetafieldReferenceQuery {
  nodes: Array<MetafieldReferenceNode | null>;
}

const countsCache = new Map<string, CacheEntry<DiagnosticsCounts>>();
const pageCache = new Map<string, CacheEntry<DiagnosticsPage>>();
const metafieldKeysCache = new Map<
  string,
  CacheEntry<DiagnosticMetafieldSelection>
>();
const rawProductPageCache = new Map<string, CacheEntry<RawProductPage>>();
const rawGenerationByShop = new Map<string, string>();

const METAFIELD_DEFINITIONS_QUERY = `#graphql
  query DiagnosticMetafieldDefinitions($after: String) {
    metafieldDefinitions(
      first: 250
      after: $after
      ownerType: PRODUCT
      constraintStatus: CONSTRAINED_AND_UNCONSTRAINED
    ) {
      nodes {
        name
        namespace
        key
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PRODUCT_PAGE_QUERY = `#graphql
  query DiagnosticProductPage(
    $after: String
    $before: String
    $first: Int
    $last: Int
    $metafieldKeys: [String!]!
    $metafieldLimit: Int!
    $publishedQuery: String!
  ) {
    products(
      first: $first
      last: $last
      after: $after
      before: $before
      query: $publishedQuery
      sortKey: ID
    ) {
      edges {
        cursor
        node {
          id
          title
          description(truncateAt: 1)
          featuredMedia {
            preview {
              image {
                url
                altText
              }
            }
          }
          priceRangeV2 {
            minVariantPrice {
              amount
            }
          }
          options {
            name
            values
          }
          metafields(first: $metafieldLimit, keys: $metafieldKeys) {
            nodes {
              namespace
              key
              type
              value
              jsonValue
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

const METAFIELD_REFERENCES_QUERY = `#graphql
  query DiagnosticMetafieldReferences($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      id
      ... on Metaobject {
        displayName
      }
      ... on TaxonomyValue {
        name
      }
    }
  }
`;

class DiagnosticsDataError extends Error {
  constructor() {
    super("We couldn't load product diagnostics from Shopify.");
    this.name = "DiagnosticsDataError";
  }
}

class DiagnosticsQueryCostError extends DiagnosticsDataError {
  constructor() {
    super();
    this.name = "DiagnosticsQueryCostError";
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
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader
        ? Number(retryAfterHeader)
        : Number.NaN;
      const delay = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : Math.max(throttleDelay(payload), 500 * (attempt + 1));

      await wait(delay);
      continue;
    }

    const exceededQueryCost = payload.errors?.some((error) => {
      const code = error.extensions?.code?.toUpperCase() ?? "";
      const message = error.message.toLowerCase();

      return (
        code.includes("MAX_COST") ||
        code.includes("QUERY_COST") ||
        (message.includes("query cost") &&
          (message.includes("exceed") || message.includes("maximum")))
      );
    });

    if (exceededQueryCost) {
      throw new DiagnosticsQueryCostError();
    }

    if (!response.ok || payload.errors?.length || !payload.data) {
      throw new DiagnosticsDataError();
    }

    return payload;
  }

  throw new DiagnosticsDataError();
}

function normalizeShop(shop: string) {
  return shop.trim().toLowerCase();
}

function pruneCache<TValue>(
  cache: Map<string, CacheEntry<TValue>>,
  now: number,
  maxEntries = MAX_CACHE_ENTRIES,
) {
  for (const [key, entry] of cache) {
    if (entry.settled && entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  if (cache.size < maxEntries) {
    return;
  }

  // Never evict an in-flight request. Keeping its promise in the cache is what
  // prevents a second full catalog scan from starting while the first runs.
  const oldest = [...cache.entries()]
    .filter(([, entry]) => entry.settled)
    .sort(([, left], [, right]) => left.createdAt - right.createdAt)[0];

  if (oldest) {
    cache.delete(oldest[0]);
  }
}

function getCachedValue<TValue>(
  cache: Map<string, CacheEntry<TValue>>,
  key: string,
  ttlMilliseconds: number,
  fetchValue: () => Promise<TValue>,
  maxEntries = MAX_CACHE_ENTRIES,
) {
  const now = Date.now();
  const cached = cache.get(key);

  if (cached && (!cached.settled || cached.expiresAt > now)) {
    return cached.value;
  }

  pruneCache(cache, now, maxEntries);

  const value = fetchValue();
  const entry: CacheEntry<TValue> = {
    createdAt: now,
    expiresAt: Number.POSITIVE_INFINITY,
    settled: false,
    value,
  };

  cache.set(key, entry);
  value.then(
    () => {
      if (cache.get(key) === entry) {
        entry.settled = true;
        entry.expiresAt = Date.now() + ttlMilliseconds;
      }
    },
    () => {
      if (cache.get(key) === entry) {
        cache.delete(key);
      }
    },
  );

  return value;
}

function invalidateRawProductPageCache(shop: string) {
  const prefix = `${normalizeShop(shop)}|`;

  for (const key of rawProductPageCache.keys()) {
    if (key.startsWith(prefix)) {
      rawProductPageCache.delete(key);
    }
  }
}

function getRawGeneration(
  shop: string,
  force: boolean,
  refreshToken?: string | null,
) {
  const shopKey = normalizeShop(shop);
  const requestedGeneration = force
    ? refreshToken || `refresh-${Date.now()}`
    : null;

  if (
    requestedGeneration &&
    rawGenerationByShop.get(shopKey) !== requestedGeneration
  ) {
    invalidateRawProductPageCache(shop);
    metafieldKeysCache.delete(
      `${shopKey}|${DIAGNOSTICS_CLASSIFICATION_VERSION}`,
    );
    rawGenerationByShop.set(shopKey, requestedGeneration);

    if (rawGenerationByShop.size > MAX_CACHE_ENTRIES) {
      const oldestShop = rawGenerationByShop.keys().next().value;
      if (oldestShop) {
        rawGenerationByShop.delete(oldestShop);
        invalidateRawProductPageCache(oldestShop);
      }
    }
  }

  return rawGenerationByShop.get(shopKey) ?? "initial";
}

function getShopifyScanVersion(rawGeneration: string) {
  return `${SHOPIFY_SCAN_VERSION_PREFIX}${rawGeneration}`;
}

async function fetchDiagnosticMetafieldKeys(admin: AdminGraphQLClient) {
  const attributesByIdentifier = new Map<string, DiagnosticAttribute>();
  let after: string | null = null;
  let previousPayload: GraphQLPayload<unknown> | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    if (previousPayload) {
      const delay = throttleDelay(previousPayload);
      if (delay > 0) {
        await wait(delay);
      }
    }

    const payload: GraphQLPayload<MetafieldDefinitionQuery> =
      await queryShopify<MetafieldDefinitionQuery>(
        admin,
        METAFIELD_DEFINITIONS_QUERY,
        { after },
      );
    const connection:
      | MetafieldDefinitionQuery["metafieldDefinitions"]
      | undefined = payload.data?.metafieldDefinitions;

    if (!connection) {
      throw new DiagnosticsDataError();
    }

    for (const definition of connection.nodes) {
      const attribute =
        getDiagnosticAttribute(definition.key) ??
        getDiagnosticAttribute(definition.name);

      if (attribute) {
        attributesByIdentifier.set(
          `${definition.namespace}.${definition.key}`,
          attribute,
        );
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    if (!hasNextPage) {
      break;
    }

    if (!connection.pageInfo.endCursor) {
      throw new DiagnosticsDataError();
    }

    after = connection.pageInfo.endCursor;
    previousPayload = payload;
  }

  // Common keys also cover legacy, definition-less product metafields.
  for (const identifier of fallbackMetafieldKeys) {
    const key = identifier.slice(identifier.indexOf(".") + 1);
    const attribute = getDiagnosticAttribute(key);

    if (attribute && !attributesByIdentifier.has(identifier)) {
      attributesByIdentifier.set(identifier, attribute);
    }
  }

  const selectedEntries = [...attributesByIdentifier.entries()].slice(
    0,
    MAX_METAFIELD_KEYS,
  );

  return {
    keys: selectedEntries.map(([identifier]) => identifier),
    attributesByIdentifier: new Map(selectedEntries),
  };
}

function getDiagnosticMetafieldKeys(admin: AdminGraphQLClient, shop: string) {
  const key = `${normalizeShop(shop)}|${DIAGNOSTICS_CLASSIFICATION_VERSION}`;
  return getCachedValue(
    metafieldKeysCache,
    key,
    METAFIELD_KEYS_CACHE_TTL_MS,
    () => fetchDiagnosticMetafieldKeys(admin),
  );
}

function getScanBatchSize(metafieldKeyCount: number) {
  // Start near Shopify's 250-node connection maximum when the nested shape is
  // inexpensive, but lower the first attempt as more metafields are requested.
  const estimatedCostPerProduct = 2 + metafieldKeyCount / 6;

  return Math.max(
    MIN_SHOPIFY_SCAN_BATCH_SIZE,
    Math.min(
      MAX_SHOPIFY_SCAN_BATCH_SIZE,
      Math.floor(TARGET_SHOPIFY_QUERY_COST / estimatedCostPerProduct),
    ),
  );
}

function clampScanBatchSize(batchSize: number) {
  return Math.max(
    MIN_SHOPIFY_SCAN_BATCH_SIZE,
    Math.min(MAX_SHOPIFY_SCAN_BATCH_SIZE, Math.floor(batchSize)),
  );
}

function getNextScanBatchSize(
  currentBatchSize: number,
  payload: GraphQLPayload<unknown>,
) {
  const cost = payload.extensions?.cost;
  const requestedCost = cost?.requestedQueryCost ?? 0;
  const actualCost = cost?.actualQueryCost ?? 0;
  const observedCost = Math.max(requestedCost, actualCost);

  if (observedCost <= 0) {
    return currentBatchSize;
  }

  const costLimitedBatch = clampScanBatchSize(
    (currentBatchSize * TARGET_SHOPIFY_QUERY_COST) / observedCost,
  );
  let nextBatchSize = currentBatchSize;

  if (observedCost > TARGET_SHOPIFY_QUERY_COST) {
    nextBatchSize = Math.min(currentBatchSize, costLimitedBatch);
  } else if (observedCost < TARGET_SHOPIFY_QUERY_COST) {
    // Grow gradually after a cheap response rather than jumping straight to
    // 250. This gives Shopify's measured requested/actual cost a chance to
    // guide every subsequent catalog batch.
    nextBatchSize = Math.min(
      costLimitedBatch,
      Math.ceil(currentBatchSize * 1.5),
    );
  }

  const throttle = cost?.throttleStatus;
  if (
    throttle &&
    throttle.currentlyAvailable < Math.max(requestedCost, actualCost)
  ) {
    nextBatchSize = Math.min(nextBatchSize, currentBatchSize);
  }

  if (throttle && throttle.currentlyAvailable < TARGET_SHOPIFY_QUERY_COST / 2) {
    nextBatchSize = Math.min(
      nextBatchSize,
      Math.floor(currentBatchSize * 0.75),
    );
  }

  return clampScanBatchSize(nextBatchSize);
}

function referenceNodeValue(node: MetafieldReferenceNode) {
  const value =
    node.__typename === "Metaobject"
      ? node.displayName
      : node.__typename === "TaxonomyValue"
        ? node.name
        : undefined;

  return value?.trim() || node.id;
}

async function fetchMetafieldReferenceValues(
  admin: AdminGraphQLClient,
  edges: ProductEdge[],
) {
  const referenceIds = [
    ...new Set(
      edges.flatMap((edge) =>
        edge.node.metafields.nodes.flatMap((metafield) =>
          getMetafieldReferenceIds(metafield),
        ),
      ),
    ),
  ];
  const valuesById = new Map<string, string>();
  let previousPayload: GraphQLPayload<unknown> | null = null;

  for (
    let offset = 0;
    offset < referenceIds.length;
    offset += MAX_REFERENCE_IDS_PER_REQUEST
  ) {
    if (previousPayload) {
      const delay = throttleDelay(previousPayload);
      if (delay > 0) {
        await wait(delay);
      }
    }

    const ids = referenceIds.slice(
      offset,
      offset + MAX_REFERENCE_IDS_PER_REQUEST,
    );
    const payload = await queryShopify<MetafieldReferenceQuery>(
      admin,
      METAFIELD_REFERENCES_QUERY,
      { ids },
    );

    for (const node of payload.data?.nodes ?? []) {
      if (node) {
        valuesById.set(node.id, referenceNodeValue(node));
      }
    }

    previousPayload = payload;
  }

  if (previousPayload) {
    const delay = throttleDelay(previousPayload);
    if (delay > 0) {
      await wait(delay);
    }
  }

  return valuesById;
}

function normalizeReturnedMetafieldKey(namespace: string, key: string) {
  const namespacePrefix = `${namespace}.`;
  return key.startsWith(namespacePrefix)
    ? key.slice(namespacePrefix.length)
    : key;
}

function mapProduct(
  node: ProductEdge["node"],
  referenceValuesById: ReadonlyMap<string, string>,
  attributesByIdentifier: ReadonlyMap<string, DiagnosticAttribute>,
): RawDiagnosticProduct {
  const image = node.featuredMedia?.preview?.image;
  const metafields = node.metafields.nodes.map((metafield) => {
    // With the `keys` filter Shopify returns `key` as `namespace.key`.
    // Unfiltered metafield queries return the bare key, so normalize both.
    const key = normalizeReturnedMetafieldKey(
      metafield.namespace,
      metafield.key,
    );

    return {
      ...metafield,
      key,
      attribute:
        attributesByIdentifier.get(`${metafield.namespace}.${key}`) ??
        getDiagnosticAttribute(key) ??
        undefined,
      referencedValues: getMetafieldReferenceIds(metafield).flatMap(
        (referenceId) => {
          const referenceValue = referenceValuesById.get(referenceId);
          return referenceValue ? [referenceValue] : [];
        },
      ),
    };
  });

  return {
    id: node.id,
    title: node.title,
    description: node.description,
    price: node.priceRangeV2?.minVariantPrice?.amount ?? null,
    imageUrl: image?.url ?? null,
    imageAlt: image?.altText ?? null,
    options: node.options,
    metafields,
  };
}

async function classifyProductEdges(
  admin: AdminGraphQLClient,
  edges: ProductEdge[],
  attributesByIdentifier: ReadonlyMap<string, DiagnosticAttribute>,
) {
  const referenceValuesById = await fetchMetafieldReferenceValues(admin, edges);

  return edges.map((edge) =>
    validateDiagnosticProduct(
      mapProduct(edge.node, referenceValuesById, attributesByIdentifier),
    ),
  );
}

async function fetchProductPageFromShopify(
  admin: AdminGraphQLClient,
  metafieldKeys: string[],
  variables: {
    after?: string | null;
    before?: string | null;
    first?: number | null;
    last?: number | null;
  },
) {
  const payload = await queryShopify<ProductPageQuery>(
    admin,
    PRODUCT_PAGE_QUERY,
    {
      after: variables.after ?? null,
      before: variables.before ?? null,
      first: variables.first ?? null,
      last: variables.last ?? null,
      metafieldKeys,
      metafieldLimit: metafieldKeys.length,
      publishedQuery: ACTIVE_ONLINE_STORE_PRODUCT_QUERY,
    },
  );
  const page = payload.data?.products;

  if (!page) {
    throw new DiagnosticsDataError();
  }

  return { page, payload };
}

function fetchProductPage(
  admin: AdminGraphQLClient,
  shop: string,
  rawGeneration: string,
  metafieldKeys: string[],
  variables: {
    after?: string | null;
    before?: string | null;
    first?: number | null;
    last?: number | null;
  },
) {
  const cacheKey = [
    normalizeShop(shop),
    DIAGNOSTICS_CLASSIFICATION_VERSION,
    rawGeneration,
    variables.after ?? "",
    variables.before ?? "",
    variables.first ?? "",
    variables.last ?? "",
    metafieldKeys.join(","),
  ].join("|");

  return getCachedValue(
    rawProductPageCache,
    cacheKey,
    RAW_PRODUCT_PAGE_CACHE_TTL_MS,
    () => fetchProductPageFromShopify(admin, metafieldKeys, variables),
    MAX_RAW_PRODUCT_PAGE_CACHE_ENTRIES,
  );
}

async function fetchAdaptiveProductPage(
  admin: AdminGraphQLClient,
  shop: string,
  rawGeneration: string,
  metafieldKeys: string[],
  variables: {
    after?: string | null;
    before?: string | null;
    direction: "forward" | "backward";
  },
  requestedBatchSize: number,
) {
  let attemptedBatchSize = clampScanBatchSize(requestedBatchSize);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await fetchProductPage(
        admin,
        shop,
        rawGeneration,
        metafieldKeys,
        {
          after: variables.after,
          before: variables.before,
          first: variables.direction === "forward" ? attemptedBatchSize : null,
          last: variables.direction === "backward" ? attemptedBatchSize : null,
        },
      );

      return {
        ...result,
        nextBatchSize: getNextScanBatchSize(attemptedBatchSize, result.payload),
      };
    } catch (error) {
      if (
        !(error instanceof DiagnosticsQueryCostError) ||
        attemptedBatchSize <= MIN_SHOPIFY_SCAN_BATCH_SIZE
      ) {
        throw error;
      }

      attemptedBatchSize = clampScanBatchSize(attemptedBatchSize / 2);
    }
  }

  throw new DiagnosticsDataError();
}

async function fetchStoreWideDiagnosticsCounts(
  admin: AdminGraphQLClient,
  shop: string,
  rawGeneration: string,
  scanVersion: string,
): Promise<DiagnosticsCounts> {
  const metafieldSelection = await getDiagnosticMetafieldKeys(admin, shop);
  let batchSize = getScanBatchSize(metafieldSelection.keys.length);
  let allProducts = 0;
  let submitted = 0;
  let warnings = 0;
  let excluded = 0;
  let after: string | null = null;
  let previousPayload: GraphQLPayload<unknown> | null = null;
  let hasNextPage = true;
  let position = 0;

  await beginDiagnosticsSnapshot(shop, scanVersion);

  try {
    while (hasNextPage) {
      if (previousPayload) {
        const delay = throttleDelay(previousPayload);
        if (delay > 0) {
          await wait(delay);
        }
      }

      const result = await fetchAdaptiveProductPage(
        admin,
        shop,
        rawGeneration,
        metafieldSelection.keys,
        {
          after,
          direction: "forward",
        },
        batchSize,
      );
      batchSize = result.nextBatchSize;
      const classifiedProducts = await classifyProductEdges(
        admin,
        result.page.edges,
        metafieldSelection.attributesByIdentifier,
      );

      await appendDiagnosticsSnapshotProducts(
        shop,
        scanVersion,
        classifiedProducts.map((product) => ({
          product,
          position: position++,
        })),
      );

      for (const diagnostic of classifiedProducts) {
        allProducts += 1;

        if (diagnostic.status === "submitted") {
          submitted += 1;
        } else if (diagnostic.status === "warning") {
          warnings += 1;
        } else {
          excluded += 1;
        }
      }

      hasNextPage = result.page.pageInfo.hasNextPage;
      if (!hasNextPage) {
        break;
      }

      if (!result.page.pageInfo.endCursor) {
        throw new DiagnosticsDataError();
      }

      after = result.page.pageInfo.endCursor;
      previousPayload = result.payload;
    }

    return await completeDiagnosticsSnapshot(shop, scanVersion, {
      allProducts,
      submitted,
      warnings,
      excluded,
    });
  } catch (error) {
    await discardDiagnosticsSnapshot(shop, scanVersion).catch(() => undefined);
    throw error;
  }
}

function matchesTab(status: DiagnosticStatus, tab: DiagnosticsTab) {
  return (
    tab === "all" ||
    (tab === "submitted" && status === "submitted") ||
    (tab === "warnings" && status === "warning") ||
    (tab === "excluded" && status === "error")
  );
}

function encodeShopifyProductCursor(edge: ProductEdge, rawGeneration: string) {
  return encodeDiagnosticsSnapshotCursor({
    productId: edge.node.id,
    scanVersion: getShopifyScanVersion(rawGeneration),
    position: -1,
    shopifyCursor: edge.cursor,
  });
}

function emptyPage(): DiagnosticsPage {
  return {
    products: [],
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
    scanVersion: "none",
  };
}

async function fetchUnfilteredPage(
  admin: AdminGraphQLClient,
  shop: string,
  rawGeneration: string,
  metafieldSelection: DiagnosticMetafieldSelection,
  after?: string | null,
  before?: string | null,
): Promise<DiagnosticsPage> {
  const decodedAfter = decodeDiagnosticsSnapshotCursor(after);
  const decodedBefore = decodeDiagnosticsSnapshotCursor(before);
  const result = await fetchProductPage(
    admin,
    shop,
    rawGeneration,
    metafieldSelection.keys,
    {
      after: decodedAfter?.shopifyCursor ?? after,
      before: decodedBefore?.shopifyCursor ?? before,
      first: before ? null : TABLE_PAGE_SIZE,
      last: before ? TABLE_PAGE_SIZE : null,
    },
  );
  const displayedEdges = before
    ? result.page.edges.slice(-TABLE_PAGE_SIZE)
    : result.page.edges.slice(0, TABLE_PAGE_SIZE);
  const classifiedProducts = await classifyProductEdges(
    admin,
    displayedEdges,
    metafieldSelection.attributesByIdentifier,
  );

  return {
    products: classifiedProducts,
    pageInfo: {
      hasNextPage: before
        ? result.page.pageInfo.hasNextPage
        : result.page.edges.length > TABLE_PAGE_SIZE ||
          result.page.pageInfo.hasNextPage,
      hasPreviousPage: before
        ? result.page.edges.length > TABLE_PAGE_SIZE ||
          result.page.pageInfo.hasPreviousPage
        : result.page.pageInfo.hasPreviousPage,
      startCursor: displayedEdges[0]
        ? encodeShopifyProductCursor(displayedEdges[0], rawGeneration)
        : null,
      endCursor: displayedEdges.at(-1)
        ? encodeShopifyProductCursor(displayedEdges.at(-1)!, rawGeneration)
        : null,
    },
    scanVersion: getShopifyScanVersion(rawGeneration),
  };
}

async function fetchForwardFilteredPage(
  admin: AdminGraphQLClient,
  shop: string,
  rawGeneration: string,
  metafieldSelection: DiagnosticMetafieldSelection,
  tab: DiagnosticsTab,
  after?: string | null,
): Promise<DiagnosticsPage> {
  let batchSize = getScanBatchSize(metafieldSelection.keys.length);
  const matches: Array<{ cursor: string; product: DiagnosticProduct }> = [];
  const decodedAfter = decodeDiagnosticsSnapshotCursor(after);
  let scanCursor = decodedAfter?.shopifyCursor ?? after ?? null;
  let previousPayload: GraphQLPayload<unknown> | null = null;

  while (matches.length <= TABLE_PAGE_SIZE) {
    if (previousPayload) {
      const delay = throttleDelay(previousPayload);
      if (delay > 0) {
        await wait(delay);
      }
    }

    const result = await fetchAdaptiveProductPage(
      admin,
      shop,
      rawGeneration,
      metafieldSelection.keys,
      {
        after: scanCursor,
        direction: "forward",
      },
      batchSize,
    );
    batchSize = result.nextBatchSize;
    const classifiedProducts = await classifyProductEdges(
      admin,
      result.page.edges,
      metafieldSelection.attributesByIdentifier,
    );

    for (let index = 0; index < result.page.edges.length; index += 1) {
      const edge = result.page.edges[index];
      const product = classifiedProducts[index];
      if (matchesTab(product.status, tab)) {
        matches.push({ cursor: edge.cursor, product });
      }

      if (matches.length > TABLE_PAGE_SIZE) {
        break;
      }
    }

    if (matches.length > TABLE_PAGE_SIZE || !result.page.pageInfo.hasNextPage) {
      break;
    }

    if (!result.page.pageInfo.endCursor) {
      throw new DiagnosticsDataError();
    }

    scanCursor = result.page.pageInfo.endCursor;
    previousPayload = result.payload;
  }

  const displayed = matches.slice(0, TABLE_PAGE_SIZE);

  return {
    products: displayed.map((match) => match.product),
    pageInfo: {
      hasNextPage: matches.length > TABLE_PAGE_SIZE,
      hasPreviousPage: Boolean(after),
      startCursor: displayed[0]
        ? encodeDiagnosticsSnapshotCursor({
            productId: displayed[0].product.id,
            scanVersion: getShopifyScanVersion(rawGeneration),
            position: -1,
            shopifyCursor: displayed[0].cursor,
          })
        : null,
      endCursor: displayed.at(-1)
        ? encodeDiagnosticsSnapshotCursor({
            productId: displayed.at(-1)!.product.id,
            scanVersion: getShopifyScanVersion(rawGeneration),
            position: -1,
            shopifyCursor: displayed.at(-1)!.cursor,
          })
        : null,
    },
    scanVersion: getShopifyScanVersion(rawGeneration),
  };
}

async function fetchBackwardFilteredPage(
  admin: AdminGraphQLClient,
  shop: string,
  rawGeneration: string,
  metafieldSelection: DiagnosticMetafieldSelection,
  tab: DiagnosticsTab,
  before: string,
): Promise<DiagnosticsPage> {
  let batchSize = getScanBatchSize(metafieldSelection.keys.length);
  const nearestMatches: Array<{
    cursor: string;
    product: DiagnosticProduct;
  }> = [];
  const decodedBefore = decodeDiagnosticsSnapshotCursor(before);
  let scanCursor: string | null = decodedBefore?.shopifyCursor ?? before;
  let previousPayload: GraphQLPayload<unknown> | null = null;

  while (nearestMatches.length <= TABLE_PAGE_SIZE) {
    if (previousPayload) {
      const delay = throttleDelay(previousPayload);
      if (delay > 0) {
        await wait(delay);
      }
    }

    const result = await fetchAdaptiveProductPage(
      admin,
      shop,
      rawGeneration,
      metafieldSelection.keys,
      {
        before: scanCursor,
        direction: "backward",
      },
      batchSize,
    );
    batchSize = result.nextBatchSize;
    const classifiedProducts = await classifyProductEdges(
      admin,
      result.page.edges,
      metafieldSelection.attributesByIdentifier,
    );

    for (let index = result.page.edges.length - 1; index >= 0; index -= 1) {
      const edge = result.page.edges[index];
      const product = classifiedProducts[index];

      if (matchesTab(product.status, tab)) {
        nearestMatches.push({ cursor: edge.cursor, product });
      }

      if (nearestMatches.length > TABLE_PAGE_SIZE) {
        break;
      }
    }

    if (
      nearestMatches.length > TABLE_PAGE_SIZE ||
      !result.page.pageInfo.hasPreviousPage
    ) {
      break;
    }

    if (!result.page.pageInfo.startCursor) {
      throw new DiagnosticsDataError();
    }

    scanCursor = result.page.pageInfo.startCursor;
    previousPayload = result.payload;
  }

  const displayed = nearestMatches.slice(0, TABLE_PAGE_SIZE).reverse();

  return {
    products: displayed.map((match) => match.product),
    pageInfo: {
      hasNextPage: true,
      hasPreviousPage: nearestMatches.length > TABLE_PAGE_SIZE,
      startCursor: displayed[0]
        ? encodeDiagnosticsSnapshotCursor({
            productId: displayed[0].product.id,
            scanVersion: getShopifyScanVersion(rawGeneration),
            position: -1,
            shopifyCursor: displayed[0].cursor,
          })
        : null,
      endCursor: displayed.at(-1)
        ? encodeDiagnosticsSnapshotCursor({
            productId: displayed.at(-1)!.product.id,
            scanVersion: getShopifyScanVersion(rawGeneration),
            position: -1,
            shopifyCursor: displayed.at(-1)!.cursor,
          })
        : null,
    },
    scanVersion: getShopifyScanVersion(rawGeneration),
  };
}

async function fetchDiagnosticsPage(
  admin: AdminGraphQLClient,
  shop: string,
  rawGeneration: string,
  options: DiagnosticsPageOptions,
) {
  if (options.tab === "excluded") {
    return emptyPage();
  }

  if (!options.force) {
    const snapshotPage = await readDiagnosticsSnapshotPage(shop, options.tab, {
      after: options.after,
      before: options.before,
      pageSize: TABLE_PAGE_SIZE,
      search: options.search,
      scanVersion: options.snapshotVersion,
    });

    if (snapshotPage) {
      return {
        products: snapshotPage.products,
        pageInfo: snapshotPage.pageInfo,
        scanVersion: snapshotPage.scanVersion,
      };
    }
  }

  if (normalizeDiagnosticsSearch(options.search ?? "")) {
    throw new DiagnosticsDataError();
  }

  const metafieldSelection = await getDiagnosticMetafieldKeys(admin, shop);

  if (options.tab === "all") {
    return fetchUnfilteredPage(
      admin,
      shop,
      rawGeneration,
      metafieldSelection,
      options.after,
      options.before,
    );
  }

  if (options.before) {
    return fetchBackwardFilteredPage(
      admin,
      shop,
      rawGeneration,
      metafieldSelection,
      options.tab,
      options.before,
    );
  }

  return fetchForwardFilteredPage(
    admin,
    shop,
    rawGeneration,
    metafieldSelection,
    options.tab,
    options.after,
  );
}

function invalidatePageCacheForShop(shop: string) {
  const prefix = `${normalizeShop(shop)}|`;
  for (const key of pageCache.keys()) {
    if (key.startsWith(prefix)) {
      pageCache.delete(key);
    }
  }
}

function invalidateCountsCacheForShop(shop: string, exceptKey?: string) {
  const prefix = `${normalizeShop(shop)}|`;

  for (const key of countsCache.keys()) {
    if (key.startsWith(prefix) && key !== exceptKey) {
      countsCache.delete(key);
    }
  }
}

export async function getDiagnosticsCounts(
  admin: AdminGraphQLClient,
  shop: string,
  options: DiagnosticsCountsOptions = {},
) {
  const normalizedShop = normalizeShop(shop);
  const force = options.force ?? false;
  const rawGeneration = getRawGeneration(shop, force, options.refreshToken);
  const refreshRequestId = options.refreshToken ?? rawGeneration;
  const scanVersion = `${DIAGNOSTICS_CLASSIFICATION_VERSION}:scan-${Date.now()}-${randomUUID()}`;

  if (!force) {
    const readySnapshot = await findReadyDiagnosticsSnapshot(shop);

    if (readySnapshot) {
      const snapshotKey = `${normalizedShop}|snapshot-${readySnapshot.scanVersion}`;
      return getCachedValue(countsCache, snapshotKey, COUNTS_CACHE_TTL_MS, () =>
        Promise.resolve(readySnapshot),
      );
    }
  }

  const key = force
    ? `${normalizedShop}|${DIAGNOSTICS_CLASSIFICATION_VERSION}|refresh-${refreshRequestId}`
    : `${normalizedShop}|${DIAGNOSTICS_CLASSIFICATION_VERSION}|build-latest`;

  if (force) {
    invalidateCountsCacheForShop(shop, key);
  }

  return getCachedValue(countsCache, key, COUNTS_CACHE_TTL_MS, async () => {
    if (!force) {
      // Another app instance may have completed the shared snapshot between
      // the first lookup and this process acquiring its in-flight cache entry.
      const readySnapshot = await findReadyDiagnosticsSnapshot(shop);

      if (readySnapshot) {
        return readySnapshot;
      }
    }

    const counts = await fetchStoreWideDiagnosticsCounts(
      admin,
      shop,
      rawGeneration,
      scanVersion,
    );
    invalidateCountsCacheForShop(shop, key);
    invalidatePageCacheForShop(shop);
    return counts;
  });
}

export async function getDiagnosticsPage(
  admin: AdminGraphQLClient,
  shop: string,
  options: DiagnosticsPageOptions,
) {
  const force = options.force ?? false;
  const normalizedSearch = normalizeDiagnosticsSearch(options.search ?? "");
  const rawGeneration = getRawGeneration(shop, force, options.refreshToken);
  let readySnapshot = force
    ? null
    : await findReadyDiagnosticsSnapshot(shop, options.snapshotVersion);

  if (
    options.snapshotVersion &&
    !options.snapshotVersion.startsWith("shopify-") &&
    !readySnapshot
  ) {
    throw new DiagnosticsDataError();
  }

  if (normalizedSearch && !readySnapshot) {
    await getDiagnosticsCounts(admin, shop, {
      force,
      refreshToken: options.refreshToken,
    });
    readySnapshot = await findReadyDiagnosticsSnapshot(shop);
  }
  const shouldReadShopify = force && !normalizedSearch;

  if (shouldReadShopify) {
    invalidatePageCacheForShop(shop);
  }

  const direction = options.before ? "before" : "after";
  const cursor = options.before ?? options.after ?? "start";
  const dataVersion =
    readySnapshot?.scanVersion ?? getShopifyScanVersion(rawGeneration);
  const key = [
    normalizeShop(shop),
    dataVersion,
    options.tab,
    direction,
    cursor,
    encodeURIComponent(normalizedSearch),
  ].join("|");

  return getCachedValue(pageCache, key, PAGE_CACHE_TTL_MS, () =>
    fetchDiagnosticsPage(admin, shop, rawGeneration, {
      ...options,
      force: shouldReadShopify,
      search: normalizedSearch,
      snapshotVersion: readySnapshot?.scanVersion,
    }),
  );
}
