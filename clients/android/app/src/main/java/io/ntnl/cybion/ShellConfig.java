package io.ntnl.cybion;

/**
 * Single source of truth for the web-app shell. Change these values (and the
 * app icon/name) to re-target this shell at another SPA.
 */
final class ShellConfig {
    static final String START_URL = "https://cybion.ntnl.io/";
    static final String[] ALLOWED_HOSTS = {"ntnl.io", "ntnl.top", "aliyun.com"};

    private ShellConfig() {}
}
