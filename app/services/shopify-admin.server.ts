export interface AdminGraphQLClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
}

interface GraphQLError {
  message: string;
}

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: GraphQLError[];
}

export class ShopifyAdminQueryError extends Error {
  constructor(message = "Shopify did not return the requested store data.") {
    super(message);
    this.name = "ShopifyAdminQueryError";
  }
}

export async function queryShopifyAdmin<TData>(
  admin: AdminGraphQLClient,
  query: string,
  variables: Record<string, unknown> = {},
) {
  const response = await admin.graphql(query, { variables });
  const payload = (await response.json()) as GraphQLResponse<TData>;

  if (!response.ok || payload.errors?.length || !payload.data) {
    throw new ShopifyAdminQueryError();
  }

  return payload.data;
}
