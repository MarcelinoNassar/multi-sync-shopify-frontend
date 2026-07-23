import { useState } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export default function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            gcTime: Infinity,
            refetchOnMount: false,
            refetchOnReconnect: false,
            refetchOnWindowFocus: false,
            retry: false,
            retryOnMount: false,
            staleTime: Infinity,
          },
        },
      }),
  );

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <Outlet />
          <ScrollRestoration />
          <Scripts />
        </QueryClientProvider>
      </body>
    </html>
  );
}
