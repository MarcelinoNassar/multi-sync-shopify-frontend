import type { LoaderFunctionArgs } from "react-router";

import {
  getDiagnosticsCounts,
  getDiagnosticsPage,
  type DiagnosticsCounts,
  type DiagnosticsPage,
  type DiagnosticsTab,
} from "../services/diagnostics.server";
import { authenticate } from "../shopify.server";

export type DiagnosticsDataResponse =
  | {
      ok: true;
      intent: "counts";
      counts: DiagnosticsCounts;
    }
  | {
      ok: true;
      intent: "page";
      tab: DiagnosticsTab;
      page: DiagnosticsPage;
    }
  | {
      ok: false;
      intent: "counts" | "page";
      error: string;
    };

const validTabs = new Set<DiagnosticsTab>([
  "all",
  "submitted",
  "warnings",
  "excluded",
]);

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<DiagnosticsDataResponse> => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const intent =
    url.searchParams.get("intent") === "counts" ? "counts" : "page";
  const force = url.searchParams.get("refresh") === "1";
  const refreshToken = url.searchParams.get("refreshToken");

  try {
    if (intent === "counts") {
      return {
        ok: true,
        intent,
        counts: await getDiagnosticsCounts(admin, session.shop, {
          force,
          refreshToken,
        }),
      };
    }

    const requestedTab = url.searchParams.get("tab") as DiagnosticsTab | null;
    const tab =
      requestedTab && validTabs.has(requestedTab) ? requestedTab : "all";

    return {
      ok: true,
      intent,
      tab,
      page: await getDiagnosticsPage(admin, session.shop, {
        tab,
        after: url.searchParams.get("after"),
        before: url.searchParams.get("before"),
        force,
        refreshToken,
        search: url.searchParams.get("search"),
        snapshotVersion: url.searchParams.get("snapshotVersion"),
      }),
    };
  } catch (error) {
    console.error("Diagnostics data request failed", error);

    return {
      ok: false,
      intent,
      error:
        intent === "counts"
          ? "Diagnostic totals couldn't be calculated. Refresh to try again."
          : "Products couldn't be loaded. Refresh to try again.",
    };
  }
};
