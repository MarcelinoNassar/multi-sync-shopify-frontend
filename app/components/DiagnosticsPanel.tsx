import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CiWarning } from "react-icons/ci";
import { IoCheckmarkDoneOutline } from "react-icons/io5";
import { VscError } from "react-icons/vsc";

import type {
  DiagnosticsCounts,
  DiagnosticsPage,
  DiagnosticsPageInfo,
  DiagnosticsTab,
} from "../services/diagnostics.server";
import {
  createDiagnosticsClientState,
  diagnosticsKeys,
  diagnosticsProductsQueryOptions,
  diagnosticsSummaryQueryOptions,
  getDiagnosticsClientState,
  type DiagnosticsClientState,
  type DiagnosticsPageNavigation,
  type DiagnosticsQueryScope,
} from "../services/diagnostics-query";
import { normalizeDiagnosticsSearch } from "../services/diagnostics-search";
import type { DiagnosticProduct } from "../services/diagnostics-validation";
import styles from "../styles/diagnostics.module.css";

const diagnosticTabs: Array<{
  id: DiagnosticsTab;
  label: string;
  countKey: keyof Pick<
    DiagnosticsCounts,
    "allProducts" | "submitted" | "warnings" | "excluded"
  >;
}> = [
  { id: "all", label: "All Products", countKey: "allProducts" },
  { id: "submitted", label: "Submitted", countKey: "submitted" },
  {
    id: "warnings",
    label: "Submitted with Warnings",
    countKey: "warnings",
  },
  { id: "excluded", label: "Excluded", countKey: "excluded" },
];

const badgeToneClass: Record<DiagnosticsTab, string> = {
  all: styles.badgeAll,
  submitted: styles.badgeSubmitted,
  warnings: styles.badgeWarning,
  excluded: styles.badgeExcluded,
};

interface DiagnosticsPanelProps {
  active: boolean;
  dataEndpoint?: string;
  scope: DiagnosticsQueryScope | null;
}

interface DiagnosticsRefreshFallback {
  counts?: DiagnosticsCounts;
  page?: {
    tab: DiagnosticsTab;
    value: DiagnosticsPage;
  };
}

interface DiagnosticsTableProps {
  canGoPrevious: boolean;
  error: string | null;
  isLoading: boolean;
  pageInfo?: DiagnosticsPageInfo;
  products: DiagnosticProduct[];
  searchTerm: string;
  onNext: () => void;
  onPrevious: () => void;
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function BadgeValue({
  isLoading,
  isRefreshing,
  toneClass,
  value,
}: {
  isLoading: boolean;
  isRefreshing: boolean;
  toneClass: string;
  value?: number;
}) {
  if (isLoading) {
    return (
      <span
        aria-label="Loading count"
        className={styles.badgeSkeleton}
        role="status"
      />
    );
  }

  return (
    <span className={`${styles.badgeValue} ${toneClass}`}>
      <span>{value === undefined ? "—" : formatCount(value)}</span>
      {isRefreshing ? (
        <span
          aria-label="Refreshing count"
          className={styles.badgeRefreshSpinner}
          role="status"
        />
      ) : null}
    </span>
  );
}

function getShopifyProductAdminUrl(productId: string) {
  const numericId = productId.split("/").at(-1);
  return `shopify://admin/products/${encodeURIComponent(numericId || productId)}`;
}

function ProductImage({ product }: { product: DiagnosticProduct }) {
  if (!product.imageUrl) {
    return (
      <span
        aria-label="No product image"
        className={styles.imageFallback}
        role="img"
      >
        <span />
      </span>
    );
  }

  return (
    <img
      alt={product.imageAlt || ""}
      className={styles.productImage}
      loading="lazy"
      src={product.imageUrl}
    />
  );
}

function StatusIcon({ status }: { status: DiagnosticProduct["status"] }) {
  if (status === "submitted") {
    return (
      <IoCheckmarkDoneOutline
        aria-label="Submitted with no warnings"
        className={styles.statusSubmitted}
        role="img"
        title="Submitted with no warnings or errors"
      />
    );
  }

  if (status === "warning") {
    return (
      <CiWarning
        aria-label="Submitted with warnings"
        className={styles.statusWarning}
        role="img"
        title="Submitted with warnings"
      />
    );
  }

  return (
    <VscError
      aria-label="Excluded because of errors"
      className={styles.statusError}
      role="img"
      title="Excluded because of errors"
    />
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }, (_, index) => (
        <tr aria-hidden="true" key={index}>
          <td>
            <div className={styles.skeletonProduct}>
              <span className={styles.skeletonImage} />
              <span className={styles.skeletonTitle} />
            </div>
          </td>
          <td className={styles.statusCell}>
            <span className={styles.skeletonStatus} />
          </td>
          <td>
            <span className={styles.skeletonWarning} />
            <span className={styles.skeletonWarningShort} />
          </td>
        </tr>
      ))}
    </>
  );
}

function DiagnosticsTable({
  canGoPrevious,
  error,
  isLoading,
  pageInfo,
  products,
  searchTerm,
  onNext,
  onPrevious,
}: DiagnosticsTableProps) {
  const emptyMessage = normalizeDiagnosticsSearch(searchTerm)
    ? "No products match your search."
    : "No products are available in this view.";

  return (
    <>
      <div className={styles.tableViewport}>
        <table className={styles.diagnosticsTable}>
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th className={styles.googleHeader} scope="col">
                <img alt="Google" src="/google-icon.png" />
              </th>
              <th scope="col">Warnings / Errors Found</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <SkeletonRows />
            ) : error && products.length === 0 ? (
              <tr>
                <td className={styles.emptyCell} colSpan={3}>
                  {error}
                </td>
              </tr>
            ) : products.length === 0 ? (
              <tr>
                <td className={styles.emptyCell} colSpan={3}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              products.map((product) => (
                <tr key={product.id}>
                  <td>
                    <div className={styles.productCell}>
                      <ProductImage product={product} />
                      <a
                        className={styles.productTitle}
                        href={getShopifyProductAdminUrl(product.id)}
                        rel="noopener noreferrer"
                        target="_blank"
                        title="Open product in Shopify Admin"
                      >
                        {product.title || "Untitled product"}
                      </a>
                    </div>
                  </td>
                  <td className={styles.statusCell}>
                    <StatusIcon status={product.status} />
                  </td>
                  <td>
                    {product.warnings.length === 0 ? (
                      <span className={styles.noWarnings}>
                        No warnings found
                      </span>
                    ) : (
                      <ul className={styles.warningList}>
                        {product.warnings.map((warning) => (
                          <li key={warning.code}>{warning.message}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.pagination}>
        <span aria-live="polite" className={styles.paginationStatus}>
          {isLoading
            ? "Loading page"
            : `${formatCount(products.length)} product${
                products.length === 1 ? "" : "s"
              } on this page`}
        </span>
        <div
          aria-label="Diagnostics pagination"
          className={styles.paginationButtons}
          role="group"
        >
          <s-button
            accessibilityLabel="Load previous diagnostics page"
            disabled={isLoading || Boolean(error) || !canGoPrevious}
            icon="chevron-left"
            onClick={onPrevious}
            variant="secondary"
          >
            Previous
          </s-button>
          <s-button
            accessibilityLabel="Load next diagnostics page"
            disabled={isLoading || Boolean(error) || !pageInfo?.hasNextPage}
            icon="chevron-right"
            onClick={onNext}
            variant="secondary"
          >
            Next
          </s-button>
        </div>
      </div>
    </>
  );
}

export function DiagnosticsPanel({
  active,
  dataEndpoint = "/app/diagnostics-data",
  scope,
}: DiagnosticsPanelProps) {
  const queryClient = useQueryClient();
  const queryScope = scope ?? {
    shop: "pending-shop",
    sessionId: "pending-session",
  };
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedTab, setSelectedTab] = useState<DiagnosticsTab>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshFallback, setRefreshFallback] =
    useState<DiagnosticsRefreshFallback | null>(null);
  const [clientState, setClientState] = useState<DiagnosticsClientState>(() =>
    scope
      ? getDiagnosticsClientState(queryClient, scope)
      : createDiagnosticsClientState(),
  );
  const normalizedSearch = normalizeDiagnosticsSearch(debouncedSearch);
  const tabNavigation = clientState.tabs[selectedTab];
  const navigation: DiagnosticsPageNavigation = normalizedSearch
    ? (tabNavigation.searches[normalizedSearch] ?? {
        history: [{ after: null }],
        index: 0,
      })
    : tabNavigation;
  const pageRequest = navigation.history[navigation.index];
  const queriesEnabled = Boolean(scope) && active;
  const fallbackPage =
    refreshFallback?.page?.tab === selectedTab
      ? refreshFallback.page.value
      : undefined;
  const summaryQuery = useQuery({
    ...diagnosticsSummaryQueryOptions(queryScope, clientState.generation, {
      endpoint: dataEndpoint,
      force: isRefreshing,
    }),
    enabled: queriesEnabled,
    placeholderData: refreshFallback?.counts,
  });
  const pageQueryOptions = diagnosticsProductsQueryOptions(
    queryScope,
    clientState.generation,
    selectedTab,
    pageRequest,
    {
      endpoint: dataEndpoint,
      force: isRefreshing,
      search: normalizedSearch,
    },
  );
  const pageQuery = useQuery({
    ...pageQueryOptions,
    enabled: queriesEnabled && selectedTab !== "excluded",
    placeholderData: fallbackPage,
  });
  // Badge totals always come from the independent store-wide summary query.
  // Paginated page data is used only by the table below.
  const storeWideCounts = summaryQuery.data ?? refreshFallback?.counts;
  const page =
    selectedTab === "excluded" ? undefined : (pageQuery.data ?? fallbackPage);
  const countsError = summaryQuery.isError ? summaryQuery.error.message : null;
  const pageError =
    selectedTab !== "excluded" && pageQuery.isError
      ? pageQuery.error.message
      : null;
  const countsLoading = summaryQuery.isPending && !storeWideCounts;
  const countsRefreshing = isRefreshing && summaryQuery.isFetching;
  const pageLoading =
    selectedTab !== "excluded" && pageQuery.isPending && !page;

  useEffect(() => {
    const nextSearch = normalizeDiagnosticsSearch(searchTerm);

    if (!nextSearch) {
      setDebouncedSearch("");
      return;
    }

    const debounceTimer = window.setTimeout(() => {
      setDebouncedSearch(nextSearch);
    }, 350);

    return () => window.clearTimeout(debounceTimer);
  }, [searchTerm]);

  useEffect(() => {
    const loadedPage = pageQuery.data;

    if (
      !active ||
      !scope ||
      selectedTab === "excluded" ||
      isRefreshing ||
      pageQuery.isFetching ||
      pageQuery.isPlaceholderData ||
      pageQuery.isError ||
      !loadedPage?.pageInfo.hasNextPage ||
      !loadedPage.pageInfo.endCursor
    ) {
      return;
    }

    const nextRequest = {
      after: loadedPage.pageInfo.endCursor,
      snapshotVersion: loadedPage.scanVersion,
    };
    const nextOptions = diagnosticsProductsQueryOptions(
      scope,
      clientState.generation,
      selectedTab,
      nextRequest,
      {
        abortOnUnmount: true,
        endpoint: dataEndpoint,
        search: normalizedSearch,
      },
    );
    const nextState = queryClient.getQueryState(nextOptions.queryKey);

    if (
      nextState?.status === "success" ||
      nextState?.fetchStatus === "fetching"
    ) {
      return;
    }

    void queryClient.prefetchQuery(nextOptions);

    return () => {
      const prefetchedQuery = queryClient
        .getQueryCache()
        .find({ queryKey: nextOptions.queryKey });

      if (prefetchedQuery?.getObserversCount() === 0) {
        void queryClient.cancelQueries({
          exact: true,
          queryKey: nextOptions.queryKey,
        });
      }
    };
  }, [
    active,
    clientState.generation,
    dataEndpoint,
    isRefreshing,
    normalizedSearch,
    pageQuery.data,
    pageQuery.isError,
    pageQuery.isFetching,
    pageQuery.isPlaceholderData,
    queryClient,
    scope,
    selectedTab,
  ]);

  const storeClientState = (nextState: DiagnosticsClientState) => {
    setClientState(nextState);
    if (scope) {
      queryClient.setQueryData(diagnosticsKeys.clientState(scope), nextState);
    }
  };

  const selectTab = (tab: DiagnosticsTab, index?: number) => {
    setSelectedTab(tab);
    setSearchTerm("");
    setDebouncedSearch("");

    if (index !== undefined) {
      tabRefs.current[index]?.focus();
    }
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | undefined;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % diagnosticTabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + diagnosticTabs.length) % diagnosticTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = diagnosticTabs.length - 1;
    }

    if (nextIndex !== undefined) {
      event.preventDefault();
      selectTab(diagnosticTabs[nextIndex].id, nextIndex);
    }
  };

  const refresh = async () => {
    if (!scope || isRefreshing) {
      return;
    }

    const nextState = createDiagnosticsClientState(
      Math.max(Date.now(), clientState.generation + 1),
    );
    const previousFallback: DiagnosticsRefreshFallback = {
      counts: storeWideCounts,
      ...(page
        ? {
            page: {
              tab: selectedTab,
              value: page,
            },
          }
        : {}),
    };

    queryClient.setQueryData(diagnosticsKeys.clientState(scope), nextState);
    flushSync(() => {
      setRefreshFallback(previousFallback);
      setIsRefreshing(true);
      setClientState(nextState);
      setSearchTerm("");
      setDebouncedSearch("");
    });

    try {
      const refreshRequests: Array<Promise<unknown>> = [
        queryClient.fetchQuery(
          diagnosticsSummaryQueryOptions(scope, nextState.generation, {
            endpoint: dataEndpoint,
            force: true,
          }),
        ),
      ];

      if (selectedTab !== "excluded") {
        refreshRequests.push(
          queryClient.fetchQuery(
            diagnosticsProductsQueryOptions(
              scope,
              nextState.generation,
              selectedTab,
              nextState.tabs[selectedTab].history[0],
              { endpoint: dataEndpoint, force: true },
            ),
          ),
        );
      }

      const results = await Promise.allSettled(refreshRequests);
      const summarySucceeded = results[0]?.status === "fulfilled";
      const pageSucceeded =
        selectedTab === "excluded" || results[1]?.status === "fulfilled";

      if (summarySucceeded && pageSucceeded) {
        queryClient.removeQueries({
          queryKey: diagnosticsKeys.shop(scope.shop),
          predicate: (query) =>
            query.queryKey[2] === scope.sessionId &&
            query.queryKey[3] !== nextState.generation,
        });
        setRefreshFallback(null);
      } else {
        setRefreshFallback((currentFallback) => {
          const nextFallback: DiagnosticsRefreshFallback = {
            counts: summarySucceeded ? undefined : currentFallback?.counts,
            page: pageSucceeded ? undefined : currentFallback?.page,
          };

          return nextFallback.counts || nextFallback.page ? nextFallback : null;
        });
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const loadPrevious = () => {
    if (navigation.index > 0) {
      const nextNavigation = {
        ...navigation,
        index: navigation.index - 1,
      };

      storeClientState({
        ...clientState,
        tabs: {
          ...clientState.tabs,
          [selectedTab]: normalizedSearch
            ? {
                ...tabNavigation,
                searches: {
                  ...tabNavigation.searches,
                  [normalizedSearch]: nextNavigation,
                },
              }
            : {
                ...tabNavigation,
                ...nextNavigation,
              },
        },
      });
    }
  };

  const loadNext = () => {
    if (!page?.pageInfo.endCursor || !page.pageInfo.hasNextPage) {
      return;
    }

    const nextRequest = {
      after: page.pageInfo.endCursor,
      snapshotVersion: page.scanVersion,
    };
    const cachedNextRequest = navigation.history[navigation.index + 1];
    const history =
      cachedNextRequest?.after === nextRequest.after &&
      cachedNextRequest.snapshotVersion === nextRequest.snapshotVersion
        ? navigation.history
        : [...navigation.history.slice(0, navigation.index + 1), nextRequest];
    const nextNavigation = {
      history,
      index: navigation.index + 1,
    };

    storeClientState({
      ...clientState,
      tabs: {
        ...clientState.tabs,
        [selectedTab]: normalizedSearch
          ? {
              ...tabNavigation,
              searches: {
                ...tabNavigation.searches,
                [normalizedSearch]: nextNavigation,
              },
            }
          : {
              ...tabNavigation,
              ...nextNavigation,
            },
      },
    });
  };

  return (
    <div className={styles.diagnostics}>
      <div className={styles.header}>
        <div>
          <s-heading>Diagnostics</s-heading>
          <s-paragraph color="subdued">
            Review products before they are submitted to Google.
          </s-paragraph>
        </div>
        <s-button
          accessibilityLabel="Refresh diagnostics data"
          disabled={isRefreshing}
          icon="refresh"
          loading={isRefreshing ? true : undefined}
          onClick={refresh}
          variant="secondary"
        >
          Refresh
        </s-button>
      </div>

      {countsError ? (
        <div className={styles.errorBanner}>
          <s-banner heading="Diagnostic totals are unavailable" tone="warning">
            {countsError} Previous totals are still shown when available. Select
            Refresh to try again.
          </s-banner>
        </div>
      ) : null}

      <div className={styles.card}>
        <div
          aria-label="Diagnostic product status"
          className={styles.innerTabs}
          role="tablist"
        >
          {diagnosticTabs.map((tab, index) => {
            const selected = tab.id === selectedTab;

            return (
              <button
                aria-controls={`diagnostics-panel-${tab.id}`}
                aria-selected={selected}
                className={styles.innerTab}
                id={`diagnostics-tab-${tab.id}`}
                key={tab.id}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                <span>{tab.label}</span>
                <BadgeValue
                  isLoading={countsLoading}
                  isRefreshing={countsRefreshing}
                  toneClass={badgeToneClass[tab.id]}
                  value={storeWideCounts?.[tab.countKey]}
                />
              </button>
            );
          })}
        </div>

        <div
          aria-labelledby={`diagnostics-tab-${selectedTab}`}
          className={styles.innerPanel}
          id={`diagnostics-panel-${selectedTab}`}
          role="tabpanel"
          tabIndex={0}
        >
          {selectedTab === "excluded" ? null : (
            <>
              <div className={styles.searchArea}>
                <s-search-field
                  label="Search products in this tab"
                  labelAccessibilityVisibility="exclusive"
                  onInput={(event) => {
                    const nextValue = event.currentTarget.value;
                    setSearchTerm(nextValue);

                    if (!normalizeDiagnosticsSearch(nextValue)) {
                      setDebouncedSearch("");
                    }
                  }}
                  placeholder="Search products"
                  value={searchTerm}
                />
              </div>

              {pageError ? (
                <div className={styles.tableError}>
                  <s-banner heading="Products are unavailable" tone="warning">
                    {pageError} Previous products are still shown when
                    available. Select Refresh to try again.
                  </s-banner>
                </div>
              ) : null}

              <DiagnosticsTable
                canGoPrevious={navigation.index > 0}
                error={pageError}
                isLoading={pageLoading}
                onNext={loadNext}
                onPrevious={loadPrevious}
                pageInfo={page?.pageInfo}
                products={page?.products ?? []}
                searchTerm={searchTerm}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
