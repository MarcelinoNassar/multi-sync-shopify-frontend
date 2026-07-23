import type { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { normalizeDiagnosticsSearch } from "./diagnostics-search";
import {
  DIAGNOSTICS_CLASSIFICATION_VERSION,
  type DiagnosticProduct,
  type DiagnosticStatus,
  type DiagnosticWarning,
} from "./diagnostics-validation";

const READY_STATUS = "ready";
const BUILDING_STATUS = "building";
const SNAPSHOTS_TO_RETAIN = 2;
const SNAPSHOT_VERSION_PREFIX = `${DIAGNOSTICS_CLASSIFICATION_VERSION}:`;

export interface DiagnosticsSnapshotCounts {
  allProducts: number;
  submitted: number;
  warnings: number;
  excluded: number;
  configurationRevision: string;
  generatedAt: string;
  scanVersion: string;
}

export interface DiagnosticsSnapshotPage {
  products: DiagnosticProduct[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  scanVersion: string;
}

interface SnapshotProductInput {
  product: DiagnosticProduct;
  position: number;
}

export interface DiagnosticsSnapshotCursor {
  productId: string;
  scanVersion: string;
  position: number;
  shopifyCursor?: string;
}

function normalizeShop(shop: string) {
  return shop.trim().toLowerCase();
}

export function encodeDiagnosticsSnapshotCursor(
  cursor: DiagnosticsSnapshotCursor,
) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeDiagnosticsSnapshotCursor(
  cursor?: string | null,
): DiagnosticsSnapshotCursor | null {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<DiagnosticsSnapshotCursor>;

    if (
      typeof parsed.productId !== "string" ||
      typeof parsed.scanVersion !== "string" ||
      typeof parsed.position !== "number" ||
      !Number.isSafeInteger(parsed.position)
    ) {
      return null;
    }

    return {
      productId: parsed.productId,
      scanVersion: parsed.scanVersion,
      position: parsed.position,
      ...(typeof parsed.shopifyCursor === "string"
        ? { shopifyCursor: parsed.shopifyCursor }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseWarnings(value: Prisma.JsonValue): DiagnosticWarning[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((warning) => {
    if (
      typeof warning === "object" &&
      warning !== null &&
      !Array.isArray(warning) &&
      typeof warning.code === "string" &&
      typeof warning.message === "string"
    ) {
      return [{ code: warning.code, message: warning.message }];
    }

    return [];
  });
}

function mapStoredProduct(product: {
  productId: string;
  title: string;
  imageUrl: string | null;
  imageAlt: string | null;
  status: string;
  warningData: Prisma.JsonValue;
}): DiagnosticProduct {
  return {
    id: product.productId,
    title: product.title,
    imageUrl: product.imageUrl,
    imageAlt: product.imageAlt,
    status:
      product.status === "submitted"
        ? "submitted"
        : product.status === "error"
          ? "error"
          : "warning",
    warnings: parseWarnings(product.warningData),
  };
}

function mapCounts(snapshot: {
  allProducts: number;
  submitted: number;
  warnings: number;
  excluded: number;
  completedAt: Date | null;
  configurationRevision: string;
  createdAt: Date;
  scanVersion: string;
}): DiagnosticsSnapshotCounts {
  return {
    allProducts: snapshot.allProducts,
    submitted: snapshot.submitted,
    warnings: snapshot.warnings,
    excluded: snapshot.excluded,
    configurationRevision: snapshot.configurationRevision,
    generatedAt: (snapshot.completedAt ?? snapshot.createdAt).toISOString(),
    scanVersion: snapshot.scanVersion,
  };
}

export async function findReadyDiagnosticsSnapshot(
  shop: string,
  scanVersion?: string | null,
) {
  if (scanVersion && !scanVersion.startsWith(SNAPSHOT_VERSION_PREFIX)) {
    return null;
  }

  const snapshot = await prisma.diagnosticsSnapshot.findFirst({
    where: {
      shop: normalizeShop(shop),
      status: READY_STATUS,
      scanVersion: scanVersion ?? { startsWith: SNAPSHOT_VERSION_PREFIX },
    },
    orderBy: {
      completedAt: "desc",
    },
  });

  return snapshot ? mapCounts(snapshot) : null;
}

export async function beginDiagnosticsSnapshot(
  shop: string,
  scanVersion: string,
  configurationRevision: string,
) {
  const normalizedShop = normalizeShop(shop);

  await prisma.diagnosticsSnapshotProduct.deleteMany({
    where: { shop: normalizedShop, scanVersion },
  });
  await prisma.diagnosticsSnapshot.deleteMany({
    where: { shop: normalizedShop, scanVersion, status: BUILDING_STATUS },
  });
  await prisma.diagnosticsSnapshot.create({
    data: {
      shop: normalizedShop,
      scanVersion,
      configurationRevision,
      status: BUILDING_STATUS,
    },
  });
}

export async function appendDiagnosticsSnapshotProducts(
  shop: string,
  scanVersion: string,
  inputs: SnapshotProductInput[],
) {
  if (inputs.length === 0) {
    return;
  }

  const normalizedShop = normalizeShop(shop);

  await prisma.diagnosticsSnapshotProduct.createMany({
    data: inputs.map(({ product, position }) => ({
      shop: normalizedShop,
      scanVersion,
      productId: product.id,
      position,
      title: product.title,
      imageUrl: product.imageUrl,
      imageAlt: product.imageAlt,
      status: product.status,
      warningData: product.warnings.map(({ code, message }) => ({
        code,
        message,
      })) as Prisma.InputJsonValue,
    })),
  });
}

export async function completeDiagnosticsSnapshot(
  shop: string,
  scanVersion: string,
  counts: Omit<
    DiagnosticsSnapshotCounts,
    "configurationRevision" | "generatedAt" | "scanVersion"
  >,
) {
  const normalizedShop = normalizeShop(shop);
  const completedAt = new Date();

  const completion = await prisma.diagnosticsSnapshot.updateMany({
    where: {
      shop: normalizedShop,
      scanVersion,
      status: BUILDING_STATUS,
    },
    data: {
      ...counts,
      completedAt,
      status: READY_STATUS,
    },
  });

  if (completion.count !== 1) {
    throw new Error("Diagnostics snapshot became stale while it was building.");
  }

  const snapshot = await prisma.diagnosticsSnapshot.findUniqueOrThrow({
    where: {
      shop_scanVersion: {
        shop: normalizedShop,
        scanVersion,
      },
    },
  });

  // Cleanup must never turn an already completed snapshot into a failed scan.
  // A later refresh can retry pruning if this best-effort step fails.
  await pruneOldDiagnosticsSnapshots(normalizedShop).catch((error) => {
    console.error("Unable to prune old Diagnostics snapshots", error);
  });
  return mapCounts(snapshot);
}

export async function discardDiagnosticsSnapshot(
  shop: string,
  scanVersion: string,
) {
  const normalizedShop = normalizeShop(shop);

  await Promise.all([
    prisma.diagnosticsSnapshotProduct.deleteMany({
      where: { shop: normalizedShop, scanVersion },
    }),
    prisma.diagnosticsSnapshot.deleteMany({
      where: {
        shop: normalizedShop,
        scanVersion,
        status: BUILDING_STATUS,
      },
    }),
  ]);
}

async function pruneOldDiagnosticsSnapshots(shop: string) {
  const snapshots = await prisma.diagnosticsSnapshot.findMany({
    where: { shop, status: READY_STATUS },
    orderBy: { completedAt: "desc" },
    select: { scanVersion: true },
  });
  const obsoleteVersions = snapshots
    .slice(SNAPSHOTS_TO_RETAIN)
    .map((snapshot) => snapshot.scanVersion);

  if (obsoleteVersions.length === 0) {
    return;
  }

  await prisma.diagnosticsSnapshot.deleteMany({
    where: {
      shop,
      scanVersion: { in: obsoleteVersions },
    },
  });
  await prisma.diagnosticsSnapshotProduct.deleteMany({
    where: {
      shop,
      scanVersion: { in: obsoleteVersions },
    },
  });
}

async function resolveSnapshotPosition(
  shop: string,
  scanVersion: string,
  cursor?: string | null,
) {
  const decoded = decodeDiagnosticsSnapshotCursor(cursor);

  if (!decoded) {
    return null;
  }

  if (decoded.scanVersion === scanVersion) {
    return decoded.position;
  }

  const matchingProduct = await prisma.diagnosticsSnapshotProduct.findFirst({
    where: {
      shop,
      scanVersion,
      productId: decoded.productId,
    },
    select: { position: true },
  });

  return matchingProduct?.position ?? null;
}

export async function readDiagnosticsSnapshotPage(
  shop: string,
  tab: "all" | "submitted" | "warnings" | "excluded",
  options: {
    after?: string | null;
    before?: string | null;
    pageSize: number;
    scanVersion?: string | null;
    search?: string | null;
  },
): Promise<DiagnosticsSnapshotPage | null> {
  const normalizedShop = normalizeShop(shop);
  const requestedCursor = options.before ?? options.after;
  const decodedCursor = decodeDiagnosticsSnapshotCursor(requestedCursor);

  if (requestedCursor && !decodedCursor) {
    return null;
  }

  const requestedVersion =
    options.scanVersion ?? decodedCursor?.scanVersion ?? null;
  const versionedSnapshot = requestedVersion
    ? await findReadyDiagnosticsSnapshot(normalizedShop, requestedVersion)
    : null;
  const snapshot =
    versionedSnapshot ??
    (!requestedVersion || requestedVersion.startsWith("shopify-")
      ? await findReadyDiagnosticsSnapshot(normalizedShop)
      : null);

  if (!snapshot) {
    return null;
  }

  const cursorPosition = await resolveSnapshotPosition(
    normalizedShop,
    snapshot.scanVersion,
    requestedCursor,
  );
  const status: DiagnosticStatus | undefined =
    tab === "submitted"
      ? "submitted"
      : tab === "warnings"
        ? "warning"
        : tab === "excluded"
          ? "error"
          : undefined;
  const normalizedSearch = normalizeDiagnosticsSearch(options.search ?? "");
  const isBackward = Boolean(options.before);
  const storedProducts = await prisma.diagnosticsSnapshotProduct.findMany({
    where: {
      shop: normalizedShop,
      scanVersion: snapshot.scanVersion,
      ...(status ? { status } : {}),
      ...(normalizedSearch
        ? {
            title: {
              contains: normalizedSearch,
              mode: "insensitive" as const,
            },
          }
        : {}),
      ...(cursorPosition === null
        ? {}
        : {
            position: isBackward
              ? { lt: cursorPosition }
              : { gt: cursorPosition },
          }),
    },
    orderBy: {
      position: isBackward ? "desc" : "asc",
    },
    take: options.pageSize + 1,
  });
  const hasExtraProduct = storedProducts.length > options.pageSize;
  const displayedRows = storedProducts.slice(0, options.pageSize);

  if (isBackward) {
    displayedRows.reverse();
  }

  return {
    products: displayedRows.map(mapStoredProduct),
    pageInfo: {
      hasNextPage: isBackward ? Boolean(requestedCursor) : hasExtraProduct,
      hasPreviousPage: isBackward ? hasExtraProduct : Boolean(requestedCursor),
      startCursor: displayedRows[0]
        ? encodeDiagnosticsSnapshotCursor({
            productId: displayedRows[0].productId,
            scanVersion: snapshot.scanVersion,
            position: displayedRows[0].position,
          })
        : null,
      endCursor: displayedRows.at(-1)
        ? encodeDiagnosticsSnapshotCursor({
            productId: displayedRows.at(-1)!.productId,
            scanVersion: snapshot.scanVersion,
            position: displayedRows.at(-1)!.position,
          })
        : null,
    },
    scanVersion: snapshot.scanVersion,
  };
}
