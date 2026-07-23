import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { searchShopCollections } from "../services/collection-search.server";
import {
  getConfigurationPageData,
  saveConfigurationForShop,
} from "../services/configuration.server";
import { ConfigurationValidationError } from "../services/configuration-validation";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  try {
    if (url.searchParams.get("intent") === "collections") {
      const page = await searchShopCollections(
        admin,
        url.searchParams.get("search"),
        url.searchParams.get("after"),
      );

      return Response.json({ ok: true, intent: "collections", page });
    }

    const data = await getConfigurationPageData(admin, session);
    return Response.json({ ok: true, intent: "configuration", ...data });
  } catch (error) {
    console.error("Configuration data request failed", error);
    return Response.json(
      {
        ok: false,
        error:
          url.searchParams.get("intent") === "collections"
            ? "Collections couldn't be loaded. Try again."
            : "Configuration couldn't be loaded. Try again.",
      },
      { status: 500 },
    );
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const value = (await request.json()) as unknown;
    const result = await saveConfigurationForShop(session, value);

    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ConfigurationValidationError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
          fields: error.fields,
        },
        { status: 400 },
      );
    }

    console.error("Configuration save failed", error);
    return Response.json(
      {
        ok: false,
        error: "Configuration couldn't be saved. Try again.",
      },
      { status: 500 },
    );
  }
};
