/** Installed by the host via injectedJavaScriptBeforeContentLoaded (main frame only). */
export interface RallyHostGlobal {
  nonce: string;
  version: number;
  /** Host → game delivery. The SDK replaces this with its dispatcher on init. */
  recv: (json: string) => void;
  /** Messages delivered before the SDK installed its dispatcher. */
  queue?: string[];
}

declare global {
  interface Window {
    __rally?: RallyHostGlobal;
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}
