import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInstalledStoreUpdate,
  buildUninstalledStoreUpdate,
  normalizeShopDomain,
} from "../app/services/store-lifecycle.ts";

test("shop domains normalize to isolated stable keys", () => {
  const firstShop = normalizeShopDomain(" First-Shop.myshopify.com ");
  const secondShop = normalizeShopDomain("second-shop.myshopify.com");

  assert.equal(firstShop, "first-shop.myshopify.com");
  assert.equal(secondShop, "second-shop.myshopify.com");
  assert.notEqual(firstShop, secondShop);
});

test("reinstall restores status, token, install date, and configuration identity", () => {
  const reinstalledAt = new Date("2026-07-23T10:00:00.000Z");
  const update = buildInstalledStoreUpdate(
    "UNINSTALLED",
    "new-access-token",
    reinstalledAt,
  );

  assert.deepEqual(update, {
    accessToken: "new-access-token",
    status: "INSTALLED",
    uninstalledAt: null,
    installedAt: reinstalledAt,
  });
  assert.equal("configuration" in update, false);
});

test("uninstall invalidates the token without deleting the record", () => {
  const uninstalledAt = new Date("2026-07-23T11:00:00.000Z");

  assert.deepEqual(buildUninstalledStoreUpdate(uninstalledAt), {
    accessToken: null,
    status: "UNINSTALLED",
    uninstalledAt,
  });
});
