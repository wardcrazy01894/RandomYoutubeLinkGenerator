/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly BASE_URL: string
  /** Optional contact address for content reports. Blank disables the mailto link. */
  readonly VITE_REPORT_EMAIL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
