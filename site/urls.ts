import { RouteUrlBucket } from "cruzo";

export const routerUrlBucket = new RouteUrlBucket({
  main: {
    url: "/",
    componentSelectorUnbox: () => "secret-auth-page-component",
    routeSelectorUnbox: () => ".section",
    loadResources: async () => {
      await import("site/components/web3/secret-auth-page.component");
    },
  },
});
