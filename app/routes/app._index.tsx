import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { DashboardTabs } from "../components/DashboardTabs";
import {
  getProductStatistics,
  getStoreInformation,
  invalidateDashboardCache,
  type ProductStatistics,
  type StoreInformation,
} from "../services/dashboard.server";
import { authenticate } from "../shopify.server";

const pendingStatistics = new Promise<ProductStatistics>(() => undefined);
const pendingStoreInformation = new Promise<StoreInformation>(() => undefined);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  return {
    // These promises start concurrently and stream independently. React
    // Router discards stale loader results after navigation or revalidation.
    storeInformation: getStoreInformation(admin, session.shop),
    statistics: getProductStatistics(admin, session.shop),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  invalidateDashboardCache(session.shop);

  return { ok: true };
};

export default function Index() {
  const { statistics, storeInformation } = useLoaderData<typeof loader>();
  const refreshFetcher = useFetcher<typeof action>();
  const isRefreshing = refreshFetcher.state !== "idle";
  const refresh = () => refreshFetcher.submit(null, { method: "post" });

  return (
    <s-page heading="Multi Sync" inlineSize="large">
      <DashboardTabs
        isRefreshing={isRefreshing}
        onRefresh={refresh}
        statistics={statistics}
        storeInformation={storeInformation}
      />
    </s-page>
  );
}

export function HydrateFallback() {
  return (
    <s-page heading="Multi Sync" inlineSize="large">
      <DashboardTabs
        isRefreshing={false}
        onRefresh={() => undefined}
        statistics={pendingStatistics}
        storeInformation={pendingStoreInformation}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
