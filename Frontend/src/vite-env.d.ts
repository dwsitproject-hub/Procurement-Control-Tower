/// <reference types="vite/client" />

/** Build-time settings (Frontend/Dockerfile build args). All optional. */
interface ImportMetaEnv {
  /** Downstream Hub base address, e.g. http://test-dwshub.kpndomain.com. */
  readonly VITE_HUB_SDK_URL?: string;
  /** The Hub SDK's publishable application key (dwsk_...). */
  readonly VITE_HUB_SDK_KEY?: string;
  /** The git commit this bundle was built from - the SDK's data-release. */
  readonly VITE_GIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
