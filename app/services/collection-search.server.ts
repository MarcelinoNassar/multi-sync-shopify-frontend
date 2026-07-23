import {
  normalizeConfigurationText,
  type SelectedCollection,
} from "./configuration-validation";
import {
  queryShopifyAdmin,
  type AdminGraphQLClient,
} from "./shopify-admin.server";

const COLLECTION_SEARCH_LIMIT = 20;
const COLLECTIONS_QUERY = `#graphql
  query ConfigurationCollections(
    $after: String
    $first: Int!
    $query: String
  ) {
    collections(
      after: $after
      first: $first
      query: $query
      sortKey: TITLE
    ) {
      nodes {
        id
        title
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

interface CollectionsQuery {
  collections: {
    nodes: SelectedCollection[];
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
    };
  };
}

export interface CollectionSearchPage {
  collections: SelectedCollection[];
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
  search: string;
}

function buildCollectionSearch(search: string) {
  if (!search) {
    return null;
  }

  const escaped = search.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `title:"${escaped}*"`;
}

export async function searchShopCollections(
  admin: AdminGraphQLClient,
  searchValue: string | null,
  after: string | null,
): Promise<CollectionSearchPage> {
  const search = normalizeConfigurationText(searchValue ?? "").slice(0, 100);
  const data = await queryShopifyAdmin<CollectionsQuery>(
    admin,
    COLLECTIONS_QUERY,
    {
      after: after || null,
      first: COLLECTION_SEARCH_LIMIT,
      query: buildCollectionSearch(search),
    },
  );

  return {
    collections: data.collections.nodes,
    pageInfo: data.collections.pageInfo,
    search,
  };
}
