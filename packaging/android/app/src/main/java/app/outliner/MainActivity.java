package app.outliner;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Outliner — 앱 안의 파이썬 서버(outliner_android.py)를 켜고 그 주소를 WebView로 열어요.
 *  WebView가 혼자 못 하는 것만 여기서: 파일 고르기 · 내려받기(서버 주소 · blob) · 바깥 링크는 브라우저로 · 마이크 권한. */
public class MainActivity extends Activity {
    private static final int PICK = 1, MIC = 2;
    private static int port = 0;  // 프로세스가 살아 있는 동안 서버는 하나
    private WebView web;
    private ValueCallback<Uri[]> picked;
    private PermissionRequest micAsk;

    // a.click()으로 blob을 내려받는 곳(북마크를 담은 파일 등) — WebView는 blob을 못 받아서 내용을 앱으로 넘겨 저장해요
    private static final String BLOB_HOOK = "(function(){if(window.__outlinerBlob)return;window.__outlinerBlob=1;"
            + "var c=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){"
            + "if(!/^blob:/.test(this.href))return c.call(this);var n=this.download||'file';"
            + "fetch(this.href).then(function(r){return r.blob()}).then(function(b){var f=new FileReader();"
            + "f.onload=function(){OutlinerAndroid.save(String(f.result).split(',')[1],n,b.type||'')};f.readAsDataURL(b)})}})()";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        FrameLayout root = new FrameLayout(this);
        root.addView(web);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {  // 안드로이드 15부터 화면이 상태 바 · 제스처 막대 · 키보드 밑까지 깔려요 → 그만큼 비워요
            root.setOnApplyWindowInsetsListener((v, ins) -> {
                android.graphics.Insets i = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setTextZoom(100);
        s.setAllowFileAccess(false);
        web.addJavascriptInterface(new Bridge(), "OutlinerAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (local(r.getUrl())) return false;
                outside(r.getUrl());
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                v.evaluateJavascript(BLOB_HOOK, null);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override  // window.open(…, '_blank') — 새 창 대신 휴대폰 브라우저로 (Dropbox 허용하기 · 링크 · 원본 보기)
            public boolean onCreateWindow(WebView v, boolean dialog, boolean gesture, android.os.Message msg) {
                WebView t = new WebView(MainActivity.this);
                t.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest r) {
                        outside(r.getUrl());
                        w.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) msg.obj).setWebView(t);
                msg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (picked != null) picked.onReceiveValue(null);
                picked = cb;
                Intent i = p.createIntent();
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(i, null), PICK);
                } catch (Exception e) {
                    picked = null;
                    return false;
                }
                return true;
            }

            @Override  // 녹음(record 플러그인) — 마이크는 안드로이드 권한부터
            public void onPermissionRequest(PermissionRequest r) {
                runOnUiThread(() -> {
                    if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        micAsk = r;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC);
                    } else r.grant(r.getResources());
                });
            }
        });
        web.setDownloadListener((url, ua, disposition, mime, len) -> download(url, disposition, mime));
        web.loadData("<html><body style='font:16px sans-serif;color:#888;display:flex;align-items:center;justify-content:center;height:90vh'>Outliner를 여는 중…</body></html>", "text/html; charset=utf-8", "utf-8");
        new Thread(() -> {
            try {
                if (port == 0) {
                    File app = unpack();
                    if (!Python.isStarted()) Python.start(new AndroidPlatform(this));
                    port = Python.getInstance().getModule("outliner_android")
                            .callAttr("start", app.getPath(), new File(getFilesDir(), "data").getPath()).toInt();
                }
                runOnUiThread(() -> web.loadUrl(base()));
            } catch (Throwable e) {
                String msg = String.valueOf(e).replace("<", "&lt;");
                runOnUiThread(() -> web.loadData("<pre style='white-space:pre-wrap'>Outliner를 켜지 못했어요\n\n" + msg + "</pre>", "text/html; charset=utf-8", "utf-8"));
            }
        }).start();
    }

    private String base() {
        return "http://127.0.0.1:" + port;
    }

    private boolean local(Uri u) {
        return "127.0.0.1".equals(u.getHost()) && u.getPort() == port;
    }

    private void outside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception e) {
            Toast.makeText(this, "열 앱이 없어요: " + u, Toast.LENGTH_SHORT).show();
        }
    }

    /** assets/app(src · plugins)을 앱 폴더에 풀어요 — 앱을 새로 설치(업데이트)했을 때만 */
    private File unpack() throws Exception {
        File dir = new File(getFilesDir(), "app");
        long stamp = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
        SharedPreferences p = getSharedPreferences("outliner", MODE_PRIVATE);
        if (p.getLong("unpacked", 0) == stamp && new File(dir, "src/server.py").exists()) return dir;
        delete(dir);
        copyAssets("app", dir);
        p.edit().putLong("unpacked", stamp).apply();
        return dir;
    }

    private void copyAssets(String path, File to) throws Exception {
        String[] kids = getAssets().list(path);
        if (kids == null || kids.length == 0) {  // 파일
            to.getParentFile().mkdirs();
            try (InputStream in = getAssets().open(path); OutputStream out = new FileOutputStream(to)) {
                copy(in, out);
            }
            return;
        }
        to.mkdirs();
        for (String k : kids) copyAssets(path + "/" + k, new File(to, k));
    }

    private static void delete(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) delete(k);
        f.delete();
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[1 << 16];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    }

    // ---- 내려받기: 휴대폰의 '다운로드' 폴더로 ----
    private void download(String url, String disposition, String mime) {
        if (url.startsWith("blob:")) {
            web.evaluateJavascript(BLOB_HOOK, null);
            return;
        }
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                String cd = c.getHeaderField("Content-Disposition");
                String type = c.getContentType() != null ? c.getContentType() : mime;
                try (InputStream in = c.getInputStream()) {
                    save(name(cd != null ? cd : disposition, url, type), type, in);
                }
            } catch (Exception e) {
                toast("내려받지 못했어요: " + e.getMessage());
            }
        }).start();
    }

    private static String name(String cd, String url, String mime) throws Exception {
        if (cd != null) {
            Matcher m = Pattern.compile("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)").matcher(cd);  // 한글 이름
            if (m.find()) return URLDecoder.decode(m.group(1).trim(), "UTF-8");
        }
        return URLUtil.guessFileName(url, cd, mime);
    }

    private void save(String name, String mime, InputStream in) throws Exception {
        String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime.split(";")[0].trim();
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            v.put(MediaStore.Downloads.MIME_TYPE, type);
            Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            try (OutputStream out = getContentResolver().openOutputStream(u)) {
                copy(in, out);
            }
        } else {
            File d = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            d.mkdirs();
            try (OutputStream out = new FileOutputStream(new File(d, name))) {
                copy(in, out);
            }
        }
        toast("다운로드 폴더에 저장했어요: " + name);
    }

    private void toast(String s) {
        runOnUiThread(() -> Toast.makeText(this, s, Toast.LENGTH_LONG).show());
    }

    private class Bridge {
        @JavascriptInterface
        public void save(String b64, String name, String mime) {
            try {
                MainActivity.this.save(name, mime, new ByteArrayInputStream(Base64.decode(b64, Base64.DEFAULT)));
            } catch (Exception e) {
                toast("저장하지 못했어요: " + e.getMessage());
            }
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != PICK || picked == null) {
            super.onActivityResult(req, res, data);
            return;
        }
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                out = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < out.length; i++) out[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) out = new Uri[]{data.getData()};
        }
        picked.onReceiveValue(out);
        picked = null;
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == MIC && micAsk != null) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) micAsk.grant(micAsk.getResources());
            else micAsk.deny();
            micAsk = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);  // 뒤로 가기로 끄지 않고 뒤로 보내요 (서버가 계속 살아 있게)
    }
}
