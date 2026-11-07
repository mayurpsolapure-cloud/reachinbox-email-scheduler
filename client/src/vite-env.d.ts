/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AUTH_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
