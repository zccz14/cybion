package io.ntnl.cybion;

import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;

/** Callbacks the WebView clients raise back to the host activity. */
interface ShellHost {
    void onExternal(String url);

    void onProgressChanged(int progress);

    void onPageStarted(String url);

    void onPageFinished(String url);

    void onMainFrameError(int errorCode, String description, String failingUrl);

    void onSslError(String failingUrl);

    void onRenderProcessGone();

    void onShowFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params);

    void onPermissionRequest(PermissionRequest request);
}
