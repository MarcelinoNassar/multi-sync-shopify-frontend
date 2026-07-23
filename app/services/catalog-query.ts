// Shopify's `published_status:published` product filter specifically targets
// the Online Store. Sharing this query keeps Dashboard and Diagnostics aligned.
export const ACTIVE_ONLINE_STORE_PRODUCT_QUERY =
  "status:active AND published_status:published";
