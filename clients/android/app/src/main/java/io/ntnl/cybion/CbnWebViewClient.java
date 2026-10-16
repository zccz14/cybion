package io.ntnl.cybion;

import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

final class CbnWebViewClient extends WebViewClient {
    // net::ERR_ABORTED. WebView reports this for navigations the page itself
    // cancelled (redirects, SPA route changes); it is not a load failure.
    private static final int ERR_ABORTED = -3;

    private final ShellHost host;

    CbnWebViewClient(ShellHost host) {
        this.host = host;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (request == null) return false;
        Uri uri = request.getUrl();
        switch (UrlPolicy.decide(uri)) {
            case IN_APP:
                return false;
            case EXTERNAL:
                host.onExternal(uri.toString());
                return true;
            default:
                return true;
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        Uri uri = Uri.parse(url);
        switch (UrlPolicy.decide(uri)) {
            case IN_APP:
                return false;
            case EXTERNAL:
                host.onExternal(url);
                return true;
            default:
                return true;
        }
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        host.onPageStarted(url);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        host.onPageFinished(url);
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request == null || !request.isForMainFrame()) return;
        int code = error != null ? error.getErrorCode() : -1;
        if (code == ERR_ABORTED) return;
        CharSequence desc = error != null ? error.getDescription() : null;
        host.onMainFrameError(code, desc != null ? desc.toString() : "", request.getUrl().toString());
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) return; // new callback handles it
        if (errorCode == ERR_ABORTED) return;
        host.onMainFrameError(errorCode, description, failingUrl);
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        if (request == null || !request.isForMainFrame() || errorResponse == null) return;
        int status = errorResponse.getStatusCode();
        if (status >= 500) {
            host.onMainFrameError(status, "HTTP " + status, request.getUrl().toString());
        }
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.cancel();
        host.onSslError(error != null && error.getUrl() != null ? error.getUrl() : "");
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        host.onRenderProcessGone();
        return true;
    }
}
