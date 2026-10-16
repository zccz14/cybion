package io.ntnl.cybion;

import android.net.Uri;

/**
 * The single branch point for navigation decisions: where does a given URL go?
 * IN_APP   -> let the WebView load it
 * EXTERNAL -> hand off to the system browser / another app
 * BLOCKED  -> swallow it
 */
final class UrlPolicy {
    enum Decision { IN_APP, EXTERNAL, BLOCKED }

    static Decision decide(Uri uri) {
        if (uri == null) return Decision.BLOCKED;
        String scheme = uri.getScheme();
        if (scheme == null) return Decision.BLOCKED;
        scheme = scheme.toLowerCase();
        switch (scheme) {
            case "http":
            case "https": {
                String host = uri.getHost();
                if (host != null && isAllowed(host)) return Decision.IN_APP;
                return Decision.EXTERNAL;
            }
            case "about":
            case "data":
            case "blob":
            case "javascript":
                return Decision.IN_APP;
            default:
                // mailto, tel, sms, geo, market, intent, custom schemes...
                return Decision.EXTERNAL;
        }
    }

    static boolean isAllowed(String host) {
        if (host == null) return false;
        for (String allowed : ShellConfig.ALLOWED_HOSTS) {
            if (host.equals(allowed) || host.endsWith("." + allowed)) return true;
        }
        return false;
    }

    private UrlPolicy() {}
}
