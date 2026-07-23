import { Suspense, useRef, useState, type KeyboardEvent } from "react";
import { Await } from "react-router";

import { InlineLoadingValue, SectionError } from "./DashboardStates";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { ConfigurationsPanel } from "./ConfigurationsPanel";
import type {
  ProductStatistics,
  StoreInformation,
} from "../services/dashboard.server";
import type { DiagnosticsQueryScope } from "../services/diagnostics-query";
import styles from "../styles/dashboard.module.css";

const tabs = [
  { id: "dashboard", label: "Dashboard" },
  { id: "feeds", label: "Feeds" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "configurations", label: "Configurations" },
] as const;

type TabId = (typeof tabs)[number]["id"];
type SectionState = "loading" | "ready" | "error";
type StatisticKey = Exclude<keyof ProductStatistics, "generatedAt">;

interface DashboardTabsProps {
  diagnosticsScope: DiagnosticsQueryScope | null;
  statistics: Promise<ProductStatistics>;
  storeInformation: Promise<StoreInformation>;
  isRefreshing: boolean;
  onRefresh: () => void;
}

interface StatisticsTableProps {
  statistics?: ProductStatistics;
  state: SectionState;
  isRetrying: boolean;
  onRetry: () => void;
}

interface StoreInformationProps {
  store?: StoreInformation;
  state: SectionState;
  isRetrying: boolean;
  onRetry: () => void;
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function StatisticsTable({
  statistics,
  state,
  isRetrying,
  onRetry,
}: StatisticsTableProps) {
  const rows: Array<{ key: StatisticKey; label: string }> = [
    { key: "totalProducts", label: "Total products" },
    { key: "publishedProducts", label: "Published products" },
    {
      key: "publishedProductVariants",
      label: "Published product variants",
    },
    { key: "unpublishedProducts", label: "Unpublished products" },
  ];

  return (
    <s-stack gap="base">
      {state === "error" ? (
        <SectionError
          heading="Product statistics couldn't be loaded"
          isRetrying={isRetrying}
          message="Shopify didn't return the catalog statistics. Try loading this section again."
          onRetry={onRetry}
        />
      ) : statistics?.totalProducts === 0 ? (
        <s-banner heading="No products found" tone="info">
          Product statistics will appear here after products are added to this
          store.
        </s-banner>
      ) : statistics?.publishedProducts === 0 ? (
        <s-banner heading="No products are published" tone="warning">
          Active products must also be available on the Online Store sales
          channel to count as published.
        </s-banner>
      ) : null}

      <s-table>
        <s-table-header-row>
          <s-table-header format="base" listSlot="primary">
            <span className={styles.tableHeaderText}>Main Feed Statistics</span>
          </s-table-header>
          <s-table-header format="numeric" listSlot="labeled">
            <span className={styles.tableHeaderText}>Net Quantity</span>
          </s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map(({ key, label }) => {
            const value = statistics?.[key];

            return (
              <s-table-row key={key}>
                <s-table-cell>{label}</s-table-cell>
                <s-table-cell>
                  <span className={styles.numericValue}>
                    {state === "loading" ? (
                      <InlineLoadingValue label={`Loading ${label}`} />
                    ) : state === "error" || value === undefined ? (
                      <span className={styles.unavailableValue}>
                        Unavailable
                      </span>
                    ) : (
                      formatCount(value)
                    )}
                  </span>
                </s-table-cell>
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}

function StoreInformationCard({
  store,
  state,
  isRetrying,
  onRetry,
}: StoreInformationProps) {
  const hasMissingInformation =
    state === "ready" && (!store?.domain || !store.currency);

  const renderValue = (
    value: string | null | undefined,
    label: string,
    skeletonWidth: "small" | "large",
  ) => {
    if (state === "loading") {
      return (
        <InlineLoadingValue
          label={`Loading store ${label}`}
          width={skeletonWidth}
        />
      );
    }

    if (state === "error") {
      return <span className={styles.unavailableValue}>Unavailable</span>;
    }

    return value ?? "Not available";
  };

  return (
    <s-stack gap="base">
      {state === "error" ? (
        <SectionError
          heading="Store information couldn't be loaded"
          isRetrying={isRetrying}
          message="Shopify didn't return this store's details. Try loading this section again."
          onRetry={onRetry}
        />
      ) : hasMissingInformation ? (
        <s-banner heading="Store information is incomplete" tone="info">
          Some store details are not currently available from Shopify.
        </s-banner>
      ) : null}

      <dl className={styles.descriptionList}>
        <div className={styles.descriptionRow}>
          <dt>Domain</dt>
          <dd>{renderValue(store?.domain, "domain", "large")}</dd>
        </div>
        <div className={styles.descriptionRow}>
          <dt>Currency</dt>
          <dd>
            {state === "ready" && store?.currency ? (
              <s-badge>{store.currency}</s-badge>
            ) : (
              renderValue(store?.currency, "currency", "small")
            )}
          </dd>
        </div>
      </dl>
    </s-stack>
  );
}

function DashboardPanelContent({
  statistics,
  storeInformation,
  isRefreshing,
  onRefresh,
}: DashboardTabsProps) {
  return (
    <>
      <div className={styles.dashboardHeader}>
        <div>
          <s-heading>Overview</s-heading>
          <s-paragraph color="subdued">
            Product publishing health and connected store details.
          </s-paragraph>
        </div>
        <div className={styles.refreshArea}>
          <span aria-live="polite" className={styles.visuallyHidden}>
            {isRefreshing ? "Refreshing dashboard data" : ""}
          </span>
          <s-button
            accessibilityLabel="Refresh dashboard data"
            icon="refresh"
            loading={isRefreshing ? true : undefined}
            onClick={onRefresh}
            variant="secondary"
          >
            Refresh
          </s-button>
        </div>
      </div>

      <div className={styles.cardGrid}>
        <s-section heading="Products">
          <s-stack gap="base">
            <s-paragraph color="subdued">
              Variants usually become individual Google feed items.
            </s-paragraph>
            <Suspense
              fallback={
                <StatisticsTable
                  isRetrying={isRefreshing}
                  onRetry={onRefresh}
                  state="loading"
                />
              }
            >
              <Await
                errorElement={
                  <StatisticsTable
                    isRetrying={isRefreshing}
                    onRetry={onRefresh}
                    state="error"
                  />
                }
                resolve={statistics}
              >
                {(loadedStatistics) => (
                  <StatisticsTable
                    isRetrying={isRefreshing}
                    onRetry={onRefresh}
                    state="ready"
                    statistics={loadedStatistics}
                  />
                )}
              </Await>
            </Suspense>
          </s-stack>
        </s-section>

        <s-section heading="Store">
          <Suspense
            fallback={
              <StoreInformationCard
                isRetrying={isRefreshing}
                onRetry={onRefresh}
                state="loading"
              />
            }
          >
            <Await
              errorElement={
                <StoreInformationCard
                  isRetrying={isRefreshing}
                  onRetry={onRefresh}
                  state="error"
                />
              }
              resolve={storeInformation}
            >
              {(store) => (
                <StoreInformationCard
                  isRetrying={isRefreshing}
                  onRetry={onRefresh}
                  state="ready"
                  store={store}
                />
              )}
            </Await>
          </Suspense>
        </s-section>
      </div>
    </>
  );
}

export function DashboardTabs(props: DashboardTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (tabId: TabId, tabIndex?: number) => {
    setActiveTab(tabId);
    if (tabIndex !== undefined) {
      tabRefs.current[tabIndex]?.focus();
    }
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | undefined;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }

    if (nextIndex !== undefined) {
      event.preventDefault();
      selectTab(tabs[nextIndex].id, nextIndex);
    }
  };

  return (
    <div className={styles.contentShell}>
      <div aria-label="Main sections" className={styles.tabList} role="tablist">
        {tabs.map((tab, index) => {
          const isActive = activeTab === tab.id;

          return (
            <button
              aria-controls={`panel-${tab.id}`}
              aria-selected={isActive}
              className={styles.tab}
              id={`tab-${tab.id}`}
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        aria-labelledby="tab-dashboard"
        className={styles.panel}
        hidden={activeTab !== "dashboard"}
        id="panel-dashboard"
        role="tabpanel"
        tabIndex={0}
      >
        <DashboardPanelContent {...props} />
      </div>

      <div
        aria-labelledby="tab-diagnostics"
        className={styles.panel}
        hidden={activeTab !== "diagnostics"}
        id="panel-diagnostics"
        role="tabpanel"
        tabIndex={0}
      >
        <DiagnosticsPanel
          active={activeTab === "diagnostics"}
          key={
            props.diagnosticsScope
              ? `${props.diagnosticsScope.shop}:${props.diagnosticsScope.sessionId}`
              : "diagnostics-pending"
          }
          scope={props.diagnosticsScope}
        />
      </div>

      <div
        aria-labelledby="tab-configurations"
        className={styles.panel}
        hidden={activeTab !== "configurations"}
        id="panel-configurations"
        role="tabpanel"
        tabIndex={0}
      >
        <ConfigurationsPanel
          active={activeTab === "configurations"}
          scope={props.diagnosticsScope}
        />
      </div>

      <div
        aria-labelledby="tab-feeds"
        className={styles.emptyPanel}
        hidden={activeTab !== "feeds"}
        id="panel-feeds"
        role="tabpanel"
        tabIndex={0}
      />
    </div>
  );
}
