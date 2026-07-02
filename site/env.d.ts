/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_API_BASE?: string;
}

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

export {};
