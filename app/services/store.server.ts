import prisma from "../db.server";
import {
  buildInstalledStoreUpdate,
  buildUninstalledStoreUpdate,
  normalizeShopDomain,
} from "./store-lifecycle";

interface StoreSession {
  accessToken?: string;
  shop: string;
}

export async function upsertInstalledStore(session: StoreSession) {
  const shopDomain = normalizeShopDomain(session.shop);
  const existing = await prisma.store.findUnique({
    where: { shopDomain },
    select: { accessToken: true, status: true },
  });
  const accessToken = session.accessToken ?? existing?.accessToken;

  if (!accessToken) {
    throw new Error(`No Shopify access token is available for ${shopDomain}.`);
  }

  return prisma.store.upsert({
    where: { shopDomain },
    create: {
      accessToken,
      shopDomain,
      status: "INSTALLED",
    },
    update: buildInstalledStoreUpdate(existing?.status ?? null, accessToken),
  });
}

export async function markStoreUninstalled(
  shop: string,
  uninstalledAt = new Date(),
) {
  return prisma.store.updateMany({
    where: { shopDomain: normalizeShopDomain(shop) },
    data: buildUninstalledStoreUpdate(uninstalledAt),
  });
}
