package io.ntnl.cybion;

import android.net.Uri;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

final class CbnWebChromeClient extends WebChromeClient {
    private final ShellHost host;

    CbnWebChromeClient(ShellHost host) {
        this.host = host;
    }

    @Override
    public void onProgressChanged(WebView view, int newProgress) {
        host.onProgressChanged(newProgress);
    }

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback,
                                     FileChooserParams fileChooserParams) {
        host.onShowFileChooser(filePathCallback, fileChooserParams);
        return true;
    }

    @Override
    public void onPermissionRequest(PermissionRequest request) {
        host.onPermissionRequest(request);
    }

    @Override
    public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
        return true;
    }
}
