package io.ntnl.cybion;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity implements ShellHost {

    private static final int REQ_FILE = 1001;
    private static final int REQ_PERM = 1002;

    private FrameLayout root;
    private WebView webView;
    private ProgressBar progressBar;
    private View errorView;
    private TextView errorText;

    private ValueCallback<Uri[]> pendingFileChooser;
    private PermissionRequest pendingPermission;
    private ConnectivityManager.NetworkCallback networkCallback;

    private boolean errorShown;
    private String lastFailedUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        root = findViewById(R.id.root);
        progressBar = findViewById(R.id.progress);
        errorView = findViewById(R.id.error);
        errorText = findViewById(R.id.error_text);
        Button retry = findViewById(R.id.retry);
        retry.setOnClickListener(v -> retryLoad());

        webView = new WebView(this);
        root.addView(webView, 0, fullParams());
        configureWebView();
        injectCompatPolyfills();

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        startNetworkMonitor();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }

        webView.loadUrl(startUrl());
    }

    private FrameLayout.LayoutParams fullParams() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(true);
        }

        webView.setBackgroundColor(color(R.color.web_bg));
        webView.setWebViewClient(new CbnWebViewClient(this));
        webView.setWebChromeClient(new CbnWebChromeClient(this));
        webView.setDownloadListener((url, ua, cd, mime, len) -> onDownloadRequested(url));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    /**
     * Runs before any page script. Android WebView (Chromium 114 on the Huawei target) lacks
     * Ed25519 in WebCrypto, which the Cybion session check requires, so we install a shim.
     */
    private void injectCompatPolyfills() {
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                String js = readAsset("ed25519-polyfill.js");
                if (!js.isEmpty()) {
                    WebViewCompat.addDocumentStartJavaScript(webView, js, java.util.Collections.singleton("*"));
                }
            }
        } catch (Exception ignored) {
        }
    }

    private String readAsset(String name) {
        java.io.InputStream in = null;
        try {
            in = getAssets().open(name);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        } catch (Exception e) {
            return "";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private int color(int resId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return getResources().getColor(resId, getTheme());
        }
        return getResources().getColor(resId);
    }

    private String startUrl() {
        Intent intent = getIntent();
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            Uri u = intent.getData();
            if (UrlPolicy.decide(u) == UrlPolicy.Decision.IN_APP) return u.toString();
        }
        return ShellConfig.START_URL;
    }

    private void retryLoad() {
        errorShown = false;
        errorView.setVisibility(View.GONE);
        if (lastFailedUrl != null) webView.loadUrl(lastFailedUrl);
        else webView.reload();
    }

    private void handleBack() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            Uri u = intent.getData();
            if (UrlPolicy.decide(u) == UrlPolicy.Decision.IN_APP) {
                webView.loadUrl(u.toString());
            } else {
                onExternal(u.toString());
            }
        }
    }

    // ---- ShellHost ----

    @Override
    public void onExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * Download hand-off. blob:/data: URLs come from in-page script and cannot be
     * resolved by an external app, so they are ignored rather than handed off.
     */
    private void onDownloadRequested(String url) {
        if (url == null) return;
        String scheme = Uri.parse(url).getScheme();
        if (scheme == null) return;
        scheme = scheme.toLowerCase();
        if (scheme.equals("blob") || scheme.equals("data")) return;
        onExternal(url);
    }

    @Override
    public void onProgressChanged(int progress) {
        progressBar.setProgress(progress);
        progressBar.setVisibility((progress >= 100 || errorShown) ? View.GONE : View.VISIBLE);
    }

    @Override
    public void onPageStarted(String url) {
        errorShown = false;
        errorView.setVisibility(View.GONE);
    }

    @Override
    public void onPageFinished(String url) {
        progressBar.setVisibility(View.GONE);
    }

    @Override
    public void onMainFrameError(int errorCode, String description, String failingUrl) {
        errorShown = true;
        lastFailedUrl = failingUrl;
        progressBar.setVisibility(View.GONE);
        errorText.setText(getString(R.string.error_body, description == null ? "" : description));
        errorView.setVisibility(View.VISIBLE);
    }

    @Override
    public void onSslError(String failingUrl) {
        errorShown = true;
        lastFailedUrl = ShellConfig.START_URL;
        progressBar.setVisibility(View.GONE);
        errorText.setText(R.string.error_ssl);
        errorView.setVisibility(View.VISIBLE);
    }

    @Override
    public void onRenderProcessGone() {
        final String url = webView.getUrl();
        root.removeView(webView);
        webView.destroy();
        webView = new WebView(this);
        configureWebView();
        injectCompatPolyfills();
        root.addView(webView, 0, fullParams());
        webView.loadUrl(url != null ? url : ShellConfig.START_URL);
    }

    @Override
    public void onShowFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(null);
        }
        pendingFileChooser = callback;
        Intent intent;
        try {
            intent = params.createIntent();
        } catch (Exception e) {
            pendingFileChooser = null;
            callback.onReceiveValue(null);
            return;
        }
        try {
            startActivityForResult(intent, REQ_FILE);
        } catch (ActivityNotFoundException e) {
            pendingFileChooser = null;
            callback.onReceiveValue(null);
            Toast.makeText(this, R.string.no_file_picker, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onPermissionRequest(PermissionRequest request) {
        Uri origin = request.getOrigin();
        if (origin == null || !UrlPolicy.isAllowed(origin.getHost())) {
            request.deny();
            return;
        }
        List<String> needed = new ArrayList<>();
        for (String res : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                    && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.CAMERA);
            }
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.RECORD_AUDIO);
            }
        }
        if (needed.isEmpty()) {
            request.grant(request.getResources());
        } else {
            pendingPermission = request;
            requestPermissions(needed.toArray(new String[0]), REQ_PERM);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (pendingFileChooser != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                }
                pendingFileChooser.onReceiveValue(result);
                pendingFileChooser = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_PERM && pendingPermission != null) {
            boolean allGranted = grantResults.length > 0;
            for (int g : grantResults) {
                if (g != PackageManager.PERMISSION_GRANTED) allGranted = false;
            }
            if (allGranted) pendingPermission.grant(pendingPermission.getResources());
            else pendingPermission.deny();
            pendingPermission = null;
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    private void startNetworkMonitor() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                runOnUiThread(() -> {
                    if (errorShown) retryLoad();
                });
            }
        };
        try {
            cm.registerNetworkCallback(new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(), networkCallback);
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void onDestroy() {
        if (networkCallback != null) {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm != null) {
                try {
                    cm.unregisterNetworkCallback(networkCallback);
                } catch (Exception ignored) {
                }
            }
            networkCallback = null;
        }
        super.onDestroy();
    }
}
