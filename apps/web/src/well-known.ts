import { APP_LINK_PREFIXES, type SiteConfig } from './config.ts';

/**
 * `/.well-known/apple-app-site-association` (iOS 13+ `components` format). Served as JSON, no extension,
 * no redirects. The app needs the matching `applinks:<domain>` / `webcredentials:<domain>` entitlement.
 */
export function buildAasa(config: SiteConfig) {
  return {
    applinks: {
      details: [
        {
          appIDs: [config.appleAppId],
          components: APP_LINK_PREFIXES.map((prefix) => ({
            '/': `/${prefix}/*`,
            comment: `Opens in the app as rally://${prefix}/...`,
          })),
        },
      ],
    },
    webcredentials: {
      apps: [config.appleAppId],
    },
  };
}

/** `/.well-known/assetlinks.json` for Android App Links (`autoVerify`) and credential sharing. */
export function buildAssetLinks(config: SiteConfig) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app',
        package_name: config.androidPackage,
        sha256_cert_fingerprints: config.androidFingerprints,
      },
    },
  ];
}
