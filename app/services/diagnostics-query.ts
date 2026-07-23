import { queryOptions, type QueryClient } from "@tanstack/react-query";

import type { DiagnosticsDataResponse } from "../routes/app.diagnostics-data";
import type {
  DiagnosticsCounts,
  DiagnosticsPage,
  DiagnosticsTab,
} from "./diagnostics.server";
import { normalizeDiagnosticsSearch } from "./diagnostics-search";
import { DIAGNOSTICS_CLASSIFICATION_VERSION } from "./diagnostics-validation";

export interface DiagnosticsQueryScope {
  shop: string;
  sessionId: string;
}

export interface DiagnosticsPageRequest {
  after: string | null;
  snapshotVersion?: string | null;
}

export interface DiagnosticsPageNavigation {
  history: DiagnosticsPageRequest[];
  index: number;
}

export interface DiagnosticsTabNavigation extends DiagnosticsPageNavigation {
  searches: Record<string, DiagnosticsPageNavigation>;
}

export interface DiagnosticsClientState {
  generation: number;
  tabs: Record<DiagnosticsTab, DiagnosticsTabNavigation>;
}

interface QueryRequestOptions {
  endpoint?: string;
  force?: boolean;
}

interface ProductsQueryRequestOptions extends QueryRequestOptions {
  abortOnUnmount?: boolean;
  search?: string;
}

const defaultEndpoint = "/app/diagnostics-data";

export const diagnosticsKeys = {
  clientState: ({ shop, sessionId }: DiagnosticsQueryScope) =>
    [
      "diagnostics-client-state",
      DIAGNOSTICS_CLASSIFICATION_VERSION,
      shop,
      sessionId,
    ] as const,
  generation: (
    { shop, sessionId }: DiagnosticsQueryScope,
    generation: number,
  ) =>
    [
      "diagnostics",
      shop,
      sessionId,
      generation,
      DIAGNOSTICS_CLASSIFICATION_VERSION,
    ] as const,
  products: (
    { shop, sessionId }: DiagnosticsQueryScope,
    generation: number,
    tab: DiagnosticsTab,
    after: string | null,
    search: string,
    snapshotVersion: string | null | undefined,
    endpoint = defaultEndpoint,
  ) =>
    [
      "diagnostics",
      shop,
      sessionId,
      generation,
      DIAGNOSTICS_CLASSIFICATION_VERSION,
      "products",
      tab,
      after ?? "start",
      normalizeDiagnosticsSearch(search),
      snapshotVersion ?? "latest",
      endpoint,
    ] as const,
  shop: (shop: string) => ["diagnostics", shop] as const,
  summary: (
    { shop, sessionId }: DiagnosticsQueryScope,
    generation: number,
    endpoint = defaultEndpoint,
  ) =>
    // The store-wide summary intentionally has no tab or page cursor. Every
    // badge reads this one cached result instead of deriving counts from a
    // currently visible table page.
    [
      "diagnostics",
      shop,
      sessionId,
      generation,
      DIAGNOSTICS_CLASSIFICATION_VERSION,
      "summary",
      endpoint,
    ] as const,
};

const diagnosticsSessionCacheOptions = {
  gcTime: Infinity,
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  staleTime: Infinity,
} as const;

function initialTabNavigation(): DiagnosticsTabNavigation {
  return {
    history: [{ after: null }],
    index: 0,
    searches: {},
  };
}

export function createDiagnosticsClientState(
  generation = 0,
): DiagnosticsClientState {
  return {
    generation,
    tabs: {
      all: initialTabNavigation(),
      submitted: initialTabNavigation(),
      warnings: initialTabNavigation(),
      excluded: initialTabNavigation(),
    },
  };
}

export function getDiagnosticsClientState(
  queryClient: QueryClient,
  scope: DiagnosticsQueryScope,
) {
  const key = diagnosticsKeys.clientState(scope);
  const cached = queryClient.getQueryData<DiagnosticsClientState>(key);

  if (cached) {
    const normalized = {
      ...cached,
      tabs: Object.fromEntries(
        Object.entries(cached.tabs).map(([tab, navigation]) => [
          tab,
          {
            ...navigation,
            searches: navigation.searches ?? {},
          },
        ]),
      ) as DiagnosticsClientState["tabs"],
    };

    if (Object.values(cached.tabs).some((navigation) => !navigation.searches)) {
      queryClient.setQueryData(key, normalized);
    }

    return normalized;
  }

  const initial = createDiagnosticsClientState();
  queryClient.setQueryData(key, initial);
  return initial;
}

function buildRequestUrl(
  endpoint: string,
  params: Record<string, string | null | undefined>,
) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      searchParams.set(key, value);
    }
  }

  return `${endpoint}?${searchParams}`;
}

async function requestDiagnostics(
  url: string,
  signal?: AbortSignal,
): Promise<DiagnosticsDataResponse> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("Diagnostics couldn't be loaded. Refresh to try again.");
  }

  return (await response.json()) as DiagnosticsDataResponse;
}

export function diagnosticsSummaryQueryOptions(
  scope: DiagnosticsQueryScope,
  generation: number,
  { endpoint = defaultEndpoint, force = false }: QueryRequestOptions = {},
) {
  return queryOptions({
    ...diagnosticsSessionCacheOptions,
    queryKey: diagnosticsKeys.summary(scope, generation, endpoint),
    queryFn: async (): Promise<DiagnosticsCounts> => {
      const payload = await requestDiagnostics(
        buildRequestUrl(endpoint, {
          intent: "counts",
          refresh: force ? "1" : null,
          refreshToken: force ? String(generation) : null,
        }),
      );

      if (!payload.ok || payload.intent !== "counts") {
        throw new Error(
          payload.ok ? "Diagnostic totals couldn't be loaded." : payload.error,
        );
      }

      return payload.counts;
    },
  });
}

export function diagnosticsProductsQueryOptions(
  scope: DiagnosticsQueryScope,
  generation: number,
  tab: DiagnosticsTab,
  request: DiagnosticsPageRequest,
  {
    abortOnUnmount = false,
    endpoint = defaultEndpoint,
    force = false,
    search = "",
  }: ProductsQueryRequestOptions = {},
) {
  const normalizedSearch = normalizeDiagnosticsSearch(search);

  return queryOptions({
    ...diagnosticsSessionCacheOptions,
    queryKey: diagnosticsKeys.products(
      scope,
      generation,
      tab,
      request.after,
      normalizedSearch,
      request.snapshotVersion,
      endpoint,
    ),
    queryFn: async ({ signal }): Promise<DiagnosticsPage> => {
      const payload = await requestDiagnostics(
        buildRequestUrl(endpoint, {
          after: request.after,
          intent: "page",
          refresh: force ? "1" : null,
          refreshToken: force ? String(generation) : null,
          search: normalizedSearch || null,
          snapshotVersion: request.snapshotVersion,
          tab,
        }),
        abortOnUnmount ? signal : undefined,
      );

      if (!payload.ok || payload.intent !== "page") {
        throw new Error(
          payload.ok ? "Products couldn't be loaded." : payload.error,
        );
      }

      return payload.page;
    },
  });
}
