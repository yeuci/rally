import type { ComponentType, RefAttributes } from 'react';
import { WebView as WebViewClass, type WebViewProps } from 'react-native-webview';

/**
 * react-native-webview 14.0.1 ships `declare class WebView<P = undefined> extends Component<WebViewProps & P>`;
 * with the default generic, `WebViewProps & undefined` collapses to `never` and every prop fails to typecheck.
 * Re-export the component with the instance methods we use and the props it actually accepts.
 */
export type WebViewHandle = Pick<WebViewClass<object>, 'injectJavaScript' | 'reload' | 'stopLoading' | 'requestFocus'>;

export const WebView = WebViewClass as unknown as ComponentType<WebViewProps & RefAttributes<WebViewHandle>>;
export type { WebViewProps, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
