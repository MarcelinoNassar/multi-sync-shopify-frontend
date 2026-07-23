export type StoreLifecycleStatus = "INSTALLED" | "UNINSTALLED";

export function normalizeShopDomain(shop: string) {
  return shop.normalize("NFKC").trim().toLowerCase();
}

export function buildInstalledStoreUpdate(
  previousStatus: StoreLifecycleStatus | null,
  accessToken: string,
  installedAt = new Date(),
) {
  return {
    accessToken,
    status: "INSTALLED" as const,
    uninstalledAt: null,
    ...(previousStatus === "UNINSTALLED" ? { installedAt } : {}),
  };
}

export function buildUninstalledStoreUpdate(uninstalledAt = new Date()) {
  return {
    accessToken: null,
    status: "UNINSTALLED" as const,
    uninstalledAt,
  };
}
