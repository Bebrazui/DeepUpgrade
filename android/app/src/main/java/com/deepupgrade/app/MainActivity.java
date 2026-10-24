package com.deepupgrade.app;

import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends AppCompatActivity {

    private static final String START_URL = "https://chat.deepseek.com/";
    private static final String SNAPSHOT_FILE = "du_spa_snapshot.html";

    private WebView webView;
    private String cachedContentJs = "";
    private String cachedInjectedCss = "";
    private String cachedRunnerHtml = "";

    private ValueCallback<Uri[]> filePathCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;

    private boolean offlineMode = false;
    private ConnectivityManager.NetworkCallback networkCallback;
    // Snapshot of the WebView UA, captured on the UI thread — shouldInterceptRequest
    // runs on a background thread where WebView methods must not be touched
    private String appUserAgent = "";
    private final java.util.Set<String> mirroringUrls = java.util.Collections.synchronizedSet(new java.util.HashSet<>());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // True Edge-to-Edge: content extends behind status bar and navigation bar seamlessly
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);

        loadExtensionAssets();

        fileChooserLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (filePathCallback == null) return;
            Uri[] files = null;
            if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                ClipData clip = result.getData().getClipData();
                if (clip != null) {
                    files = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) files[i] = clip.getItemAt(i).getUri();
                } else if (result.getData().getData() != null) {
                    files = new Uri[]{result.getData().getData()};
                }
            }
            filePathCallback.onReceiveValue(files);
            filePathCallback = null;
        });

        configureWebView();
        registerNetworkWatch();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    finish();
                }
            }
        });

        // Load DeepSeek with standard cache persistence
        webView.loadUrl(START_URL);
    }

    private void loadExtensionAssets() {
        try {
            cachedContentJs = readAsset("content.js");
            cachedInjectedCss = readAsset("injected.css");
            cachedRunnerHtml = readAsset("runner.html");
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private String readAsset(String name) throws IOException {
        InputStream stream = getAssets().open(name);
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = stream.read(chunk)) > 0) buffer.write(chunk, 0, n);
        stream.close();
        return buffer.toString("UTF-8");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();

        // 1. Storage & Scripts
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);

        // 2. Cache mode (adaptive: switched by network watcher below)
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // 3. Viewport & Sizing — lock to native look (no zoom, no system font scaling)
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);

        // Authentic Chrome User-Agent: removes WebView signatures ("Version/4.0", "; wv")
        // Google & Cloudflare OAuth check navigator.userAgent and block sign-in if WebView tokens are present
        String rawUa = settings.getUserAgentString();
        String cleanUa = rawUa.replaceAll("(?i);?\\s*wv", "")
                               .replaceAll("(?i)Version/\\d+\\.\\d+\\s*", "");
        settings.setUserAgentString(cleanUa);
        appUserAgent = cleanUa;

        // Native feel: dark background (no white flash), no web overscroll glow, no long-press menus
        webView.setBackgroundColor(Color.parseColor("#141416"));
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        webView.setOnLongClickListener(v -> true);

        // Cookies
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            // Native file picker for chat attachments (uploads, images, documents)
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    fileChooserLauncher.launch(params.createIntent());
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost() == null ? "" : uri.getHost();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (scheme.equals("http") || scheme.equals("https")) {
                    // Keep DeepSeek and auth providers (Google/Apple/MS login) in-app,
                    // so OAuth cookies land in this WebView and not in an external browser
                    if (host.endsWith("deepseek.com") || isAuthFlowHost(host)) return false;
                    openExternally(uri);
                    return true;
                }
                openExternally(uri);
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return interceptDeepseek(request);
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                injectStylesAndScripts();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectStylesAndScripts();
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (!request.isForMainFrame()) return;
                int code = error.getErrorCode();
                if (code == ERROR_HOST_LOOKUP || code == ERROR_CONNECT
                        || code == ERROR_TIMEOUT || code == ERROR_IO) {
                    // Reload once from the snapshot + HTTP cache instead of showing a web error page
                    if (!offlineMode) {
                        enterOfflineMode();
                        view.reload();
                    }
                }
            }
        });
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
        }
    }

    /** OAuth/account hosts that must stay inside the WebView for login to complete in-app. */
    private boolean isAuthFlowHost(String host) {
        return host.endsWith("accounts.google.com")
                || host.equals("accounts.youtube.com")
                || host.endsWith(".gstatic.com")
                || host.equals("appleid.apple.com")
                || host.endsWith("icloud.com")
                || host.equals("login.microsoftonline.com")
                || host.equals("login.live.com")
                || host.equals("github.com");
    }

    /**
     * Transparent offline mirror for *.deepseek.com.
     * Online: Chromium loads everything natively; we only copy static assets into
     * a disk mirror in the background (never serving our own bytes live — SRI on
     * DeepSeek's bundles rejects any byte that differs from the native response).
     * Offline: the SPA shell comes from the snapshot, statics from the mirror.
     * API/XHR traffic is never touched. Runs on a background thread.
     */
    private WebResourceResponse interceptDeepseek(WebResourceRequest request) {
        Uri uri = request.getUrl();
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (!(scheme.equals("http") || scheme.equals("https"))) return null;
        if (!"GET".equals(request.getMethod())) return null;

        String host = uri.getHost() == null ? "" : uri.getHost();
        boolean isChatHost = host.equals("chat.deepseek.com");
        boolean isDeepseekStatic = !isChatHost
                && (host.endsWith(".deepseek.com") || host.equals("deepseek.com"));
        if (!isChatHost && !isDeepseekStatic) return null;

        if (isChatHost) {
            // Only the HTML document; API/XHR traffic must pass through untouched
            Map<String, String> headers = request.getRequestHeaders();
            String accept = headers != null ? headers.get("Accept") : null;
            if (accept == null || !accept.contains("text/html")) return null;
            return fetchDocumentWithSnapshot(uri);
        }

        if (offlineMode) {
            return serveMirroredStatic(uri);
        }
        warmMirror(uri.toString());
        return null;
    }

    private WebResourceResponse fetchDocumentWithSnapshot(Uri uri) {
        if (!offlineMode) {
            byte[] fresh = httpGet(uri.toString(), "text/html", false);
            if (fresh != null && looksLikeSpaShell(fresh)) {
                persistSnapshot(fresh);
                return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(fresh));
            }
            // Unexpected upstream answer (challenge / error page): let Chromium load natively
            if (fresh != null) return null;
        }
        // Offline (or upstream failure): serve the last saved SPA shell
        File snapshot = snapshotFile();
        if (snapshot.exists()) {
            try {
                return new WebResourceResponse("text/html", "utf-8", new FileInputStream(snapshot));
            } catch (IOException ignored) {
            }
        }
        return null;
    }

    /** Guard so an error/bot-challenge page can never replace the real SPA shell. */
    private boolean looksLikeSpaShell(byte[] html) {
        String s = new String(html, StandardCharsets.UTF_8);
        if (s.length() < 200) return false;
        boolean hasRoot = s.contains("id=\"root\"");
        boolean hasBundles = s.contains("fe-static.deepseek.com") || s.contains("/chat/static/");
        boolean looksLikeError = s.contains("Request blocked") || s.contains("403 ERROR")
                || s.contains("AccessDenied") || s.contains("error-code");
        return hasRoot && hasBundles && !looksLikeError;
    }

    private WebResourceResponse serveMirroredStatic(Uri uri) {
        File body = new File(httpCacheDir(), cacheKey(uri.toString()));
        if (!body.exists()) return null;
        String mime = guessMime(uri);
        String encoding = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json")
                ? "utf-8" : null;
        try {
            return new WebResourceResponse(mime, encoding, new FileInputStream(body));
        } catch (IOException ignored) {
            return null;
        }
    }

    /** Duplicates the Chromium fetch in the background so the offline mirror fills up silently. */
    private void warmMirror(String url) {
        if (url.length() > 512) return;
        File body = new File(httpCacheDir(), cacheKey(url));
        if (body.exists()) return;
        if (!mirroringUrls.add(url)) return;
        new Thread(() -> {
            try {
                // identity encoding: store plain bytes so the copy is byte-identical
                byte[] data = httpGet(url, null, true);
                if (data != null && data.length > 0 && data.length <= 8L * 1024 * 1024) {
                    persistCacheEntry(body, data);
                }
            } finally {
                mirroringUrls.remove(url);
            }
        }, "du-mirror").start();
    }

    private byte[] httpGet(String url, String accept, boolean identityEncoding) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(true);
            if (accept != null) conn.setRequestProperty("Accept", accept);
            if (identityEncoding) conn.setRequestProperty("Accept-Encoding", "identity");
            if (!appUserAgent.isEmpty()) conn.setRequestProperty("User-Agent", appUserAgent);
            conn.setRequestProperty("Referer", "https://chat.deepseek.com/");
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) conn.setRequestProperty("Cookie", cookies);
            int status = conn.getResponseCode();
            if (status >= 200 && status < 300) {
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                InputStream in = conn.getInputStream();
                byte[] chunk = new byte[8192];
                int n;
                while ((n = in.read(chunk)) > 0) buffer.write(chunk, 0, n);
                in.close();
                return buffer.toByteArray();
            }
        } catch (IOException ignored) {
        }
        return null;
    }

    private File httpCacheDir() {
        File dir = new File(getFilesDir(), "du_http_cache");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private String cacheKey(String url) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(url.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 12; i++) sb.append(String.format("%02x", hash[i]));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(url.hashCode());
        }
    }

    private void persistCacheEntry(File dst, byte[] data) {
        try {
            File tmp = new File(dst.getParentFile(), dst.getName() + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(data);
            out.flush();
            out.close();
            if (!tmp.renameTo(dst)) {
                dst.delete();
                tmp.renameTo(dst);
            }
            compactCacheIfNeeded(dst.getParentFile());
        } catch (IOException ignored) {
        }
    }

    /** Keeps the offline mirror under 64 MB by dropping the least recently written entries. */
    private void compactCacheIfNeeded(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        long total = 0;
        for (File f : files) total += f.length();
        if (total <= 64L * 1024 * 1024) return;
        java.util.Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File f : files) {
            if (total <= 48L * 1024 * 1024) break;
            total -= f.length();
            f.delete();
        }
    }

    private String guessMime(Uri uri) {
        String p = uri.getPath() == null ? "" : uri.getPath().toLowerCase(Locale.US);
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".map")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".avif")) return "image/avif";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".otf")) return "font/otf";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".mp4")) return "video/mp4";
        if (p.endsWith(".pdf")) return "application/pdf";
        return "application/octet-stream";
    }

    private File snapshotFile() {
        return new File(getFilesDir(), SNAPSHOT_FILE);
    }

    private void persistSnapshot(byte[] body) {
        try {
            File tmp = new File(getFilesDir(), SNAPSHOT_FILE + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(body);
            out.flush();
            out.close();
            File dst = snapshotFile();
            if (!tmp.renameTo(dst)) {
                dst.delete();
                tmp.renameTo(dst);
            }
        } catch (IOException ignored) {
        }
    }

    private void enterOfflineMode() {
        offlineMode = true;
        webView.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
    }

    private void exitOfflineMode() {
        offlineMode = false;
        webView.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
    }

    private void registerNetworkWatch() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                runOnUiThread(() -> {
                    boolean wasOffline = offlineMode;
                    exitOfflineMode();
                    if (wasOffline) webView.reload();
                });
            }

            @Override
            public void onLost(Network network) {
                runOnUiThread(MainActivity.this::enterOfflineMode);
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
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
            }
        }
        super.onDestroy();
    }

    private void injectStylesAndScripts() {
        // Strip out navigator.webdriver, mock authentic userAgentData and hide Android WebView traces
        String stealthScript = "javascript:(function() {" +
                "try {" +
                "  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });" +
                "  if (navigator.userAgentData) {" +
                "    const cleanBrands = (" +
                "      (navigator.userAgentData.brands || []).filter(b => !/wv|webview/i.test(b.brand))" +
                "    );" +
                "    Object.defineProperty(navigator.userAgentData, 'brands', { get: () => cleanBrands, configurable: true });" +
                "  }" +
                "} catch(e) {}" +
                "})()";
        webView.evaluateJavascript(stealthScript, null);

        if (!cachedInjectedCss.isEmpty()) {
            String encodedCss = Base64.encodeToString(cachedInjectedCss.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            String cssInjection = "javascript:(function() {" +
                    "if (document.getElementById('du-injected-style')) return;" +
                    "var parent = document.head || document.documentElement;" +
                    "var style = document.createElement('style');" +
                    "style.id = 'du-injected-style';" +
                    "style.type = 'text/css';" +
                    "style.innerHTML = window.atob('" + encodedCss + "');" +
                    "parent.appendChild(style);" +
                    "})()";
            webView.evaluateJavascript(cssInjection, null);
        }

        if (!cachedContentJs.isEmpty()) {
            String encodedRunner = Base64.encodeToString(cachedRunnerHtml.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            String encodedJs = Base64.encodeToString(cachedContentJs.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            String jsInjection = "javascript:(function() {" +
                    "if (window.__du_injected) return;" +
                    "window.__du_injected = true;" +
                    "try {" +
                    "window.__DU_RUNNER_HTML__ = decodeURIComponent(escape(window.atob('" + encodedRunner + "')));" +
                    "var s = document.createElement('script');" +
                    "s.textContent = decodeURIComponent(escape(window.atob('" + encodedJs + "')));" +
                    "(document.head || document.documentElement).appendChild(s);" +
                    "} catch(err) { console.error('[DeepUpgrade Android Error]', err); }" +
                    "})()";
            webView.evaluateJavascript(jsInjection, null);
        }
    }
}
