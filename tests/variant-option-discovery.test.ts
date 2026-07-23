import assert from "node:assert/strict";
import test from "node:test";

import {
  clearShopVariantOptionNamesCache,
  getShopVariantOptionNames,
} from "../app/services/variant-option-discovery.server.ts";
import type { AdminGraphQLClient } from "../app/services/shopify-admin.server.ts";

function optionNamesAdmin(optionNames: string[]) {
  let calls = 0;
  const admin: AdminGraphQLClient = {
    async graphql(query) {
      calls += 1;
      assert.match(query, /options\s*\{\s*name\s*\}/);
      assert.doesNotMatch(query, /variants|values/);

      return new Response(
        JSON.stringify({
          data: {
            products: {
              nodes: optionNames.map((name) => ({
                options: [{ name }],
              })),
              pageInfo: {
                endCursor: null,
                hasNextPage: false,
              },
            },
          },
          extensions: {
            cost: {
              actualQueryCost: 10,
              requestedQueryCost: 10,
              throttleStatus: {
                currentlyAvailable: 1000,
                restoreRate: 50,
              },
            },
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );
    },
  };

  return {
    admin,
    get calls() {
      return calls;
    },
  };
}

test("option discovery is de-duplicated, request-coalesced, and shop isolated", async () => {
  clearShopVariantOptionNamesCache();
  const firstShop = optionNamesAdmin([" Couleur ", "couleur", "Taille"]);
  const secondShop = optionNamesAdmin(["Material"]);

  const [firstRequest, duplicateRequest] = await Promise.all([
    getShopVariantOptionNames(firstShop.admin, "first-shop.myshopify.com"),
    getShopVariantOptionNames(firstShop.admin, "first-shop.myshopify.com"),
  ]);
  const secondRequest = await getShopVariantOptionNames(
    secondShop.admin,
    "second-shop.myshopify.com",
  );

  assert.deepEqual(firstRequest, ["Couleur", "Taille"]);
  assert.deepEqual(duplicateRequest, firstRequest);
  assert.deepEqual(secondRequest, ["Material"]);
  assert.equal(firstShop.calls, 1);
  assert.equal(secondShop.calls, 1);
});
