package com.vcall.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * A janela do Vcall no celular: um WebView em tela cheia.
 *
 * A tela inicial vem de dentro do APK (assets/inicio). A chamada vem do
 * servidor de quem convidou — o app de mesa com o túnel —, a MESMA interface
 * que roda no computador, então as duas pontas falam sempre a mesma versão do
 * protocolo. O que o WebView não faz sozinho fica aqui: permissões, escolher
 * arquivo, salvar download, mini-janela (picture-in-picture), seguir com a
 * chamada em segundo plano, girar a tela sem recarregar e abrir convites.
 */
public class MainActivity extends Activity {

    /** Origem falsa que serve os arquivos de assets/ (o mesmo host do WebViewAssetLoader). */
    static final String HOST_LOCAL = "appassets.androidplatform.net";
    static final String INICIO = "https://" + HOST_LOCAL + "/inicio/index.html";
    static final String ACAO_SAIR = "com.vcall.app.SAIR";
    static final String ACAO_INSTALACAO = "com.vcall.app.INSTALACAO";

    private static final int PEDIDO_PERMISSOES = 1;
    private static final int PEDIDO_ARQUIVO = 2;

    private FrameLayout raiz;
    private WebView web;
    private Ponte ponte;
    private String injetar;

    private PermissionRequest pedidoPendente;
    private ValueCallback<Uri[]> arquivoPendente;
    private String linkPendente;

    /** Lidos pela Ponte, que roda numa thread do WebView. */
    volatile boolean naTelaInicial = true;
    volatile boolean emChamada = false;
    private boolean naMiniJanela = false;

    @Override
    protected void onCreate(Bundle salvo) {
        super.onCreate(salvo);
        injetar = lerAsset("injetar.js");
        ponte = new Ponte(this);

        raiz = new FrameLayout(this);
        raiz.setBackgroundColor(corDoFundo());
        setContentView(raiz);
        ajustarBordas();

        // Build de depuração: dá para inspecionar a página pelo chrome://inspect (e testar).
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        criarWebView();

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::voltar);
        }

        if (!tratarIntent(getIntent())) web.loadUrl(INICIO);
    }

    /* ------------------------------------------------------------------ *
     * WebView
     * ------------------------------------------------------------------ */

    private void criarWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        raiz.addView(web, new FrameLayout.LayoutParams(-1, -1));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // o som de quem fala toca sem toque
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setTextZoom(100); // a interface já se adapta; a fonte do sistema estourava os botões
        s.setUserAgentString(s.getUserAgentString() + " VcallAndroid/" + versao());
        web.addJavascriptInterface(ponte, "VcallAndroid");

        web.setWebViewClient(new Cliente());
        web.setWebChromeClient(cromo = new Cromo());
        // Download de link http(s) comum: quem sabe baixar é o navegador.
        web.setDownloadListener((url, ua, disp, mime, tam) -> {
            if (url.startsWith("http")) abrirFora(Uri.parse(url));
        });
    }

    private class Cliente extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            // Aqui, e não no onPageStarted: este pedido vem antes de qualquer
            // script da página, e a tela inicial já chama a ponte ao carregar.
            if (req.isForMainFrame()) naTelaInicial = HOST_LOCAL.equals(u.getHost());
            if (!HOST_LOCAL.equals(u.getHost())) return null;
            String caminho = u.getPath() == null ? "" : u.getPath().replaceFirst("^/", "");
            if (caminho.contains("..")) return null;
            try {
                return new WebResourceResponse(tipo(caminho), "utf-8", getAssets().open(caminho));
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null); // a frase do status só aceita ASCII: com acento, o app fecha
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            Uri alvo = req.getUrl();
            String esquema = alvo.getScheme() == null ? "" : alvo.getScheme();
            if (esquema.equals("vcall")) {
                String sala = Links.paraSala(alvo.toString());
                if (sala != null) abrirSala(sala);
                return true;
            }
            // Mesma origem da página atual: segue no app. Qualquer outro lugar
            // (WhatsApp, ajuda, site do projeto) abre fora — uma página da
            // chamada nunca leva o app para outro servidor.
            Uri atual = Uri.parse(v.getUrl() == null ? "" : v.getUrl());
            boolean mesmaOrigem = esquema.equals(atual.getScheme())
                    && alvo.getHost() != null && alvo.getHost().equals(atual.getHost())
                    && alvo.getPort() == atual.getPort();
            if (mesmaOrigem) return false;
            // Convite encurtado (is.gd): o encurtador manda para o túnel da chamada.
            if (req.isRedirect() && Links.ehEncurtador(atual.getHost()) && esquema.equals("https")) return false;
            abrirFora(alvo);
            return true;
        }

        @Override
        public void onPageStarted(WebView v, String url, Bitmap icone) {
            naTelaInicial = url.startsWith(INICIO);
            if (naTelaInicial) chamada(false);
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            // Só nas páginas da sala; as do próprio APK (início, erro) não precisam.
            if (!HOST_LOCAL.equals(Uri.parse(url).getHost())) v.evaluateJavascript(injetar, null);
        }

        /** A Cloudflare respondeu com a página de erro dela (túnel fechado: 530, 502…). */
        @Override
        public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse resp) {
            if (!req.isForMainFrame() || HOST_LOCAL.equals(req.getUrl().getHost())) return;
            if (resp.getStatusCode() >= 500) mostrarErro(req.getUrl(), resp.getStatusCode());
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest req, android.webkit.WebResourceError erro) {
            if (!req.isForMainFrame() || HOST_LOCAL.equals(req.getUrl().getHost())) return;
            mostrarErro(req.getUrl(), erro.getErrorCode());
        }

        /** A página caiu (pouca memória, falha do motor): recria e volta para a mesma sala. */
        @Override
        public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
            String ultima = v.getUrl();
            raiz.removeView(v);
            v.destroy();
            criarWebView();
            web.loadUrl(ultima != null ? ultima : INICIO);
            return true;
        }
    }

    private class Cromo extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest req) {
            runOnUiThread(() -> pedirPermissoes(req));
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest req) {
            if (pedidoPendente == req) pedidoPendente = null;
        }

        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (arquivoPendente != null) arquivoPendente.onReceiveValue(null);
            arquivoPendente = cb;
            Intent i = p.createIntent();
            if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(i, PEDIDO_ARQUIVO);
            } catch (Exception e) {
                arquivoPendente = null;
                return false;
            }
            return true;
        }

        /** Sem isto, todo <video> sem imagem mostra o "play" cinza do WebView. */
        @Override
        public Bitmap getDefaultVideoPoster() {
            return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        }

        /*
         * Tela cheia pedida pela página (a tela compartilhada, ui/stage.js).
         * Sem sobrescrever isto, o WebView diz que não tem tela cheia
         * (document.fullscreenEnabled = false). A view vem por cima de tudo e
         * sem a barra de navegação; quem gira é a página, pela Ponte.girar.
         */
        @Override
        public void onShowCustomView(View view, CustomViewCallback cb) {
            if (telaCheia != null) {
                cb.onCustomViewHidden();
                return;
            }
            telaCheia = view;
            sairDaTelaCheia = cb;
            raiz.addView(view, new FrameLayout.LayoutParams(-1, -1));
            barraDeNavegacao(false);
        }

        @Override
        public void onHideCustomView() {
            if (telaCheia == null) return;
            raiz.removeView(telaCheia);
            telaCheia = null;
            barraDeNavegacao(true);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            CustomViewCallback cb = sairDaTelaCheia;
            sairDaTelaCheia = null;
            if (cb != null) cb.onCustomViewHidden();
        }
    }

    private View telaCheia;
    private WebChromeClient.CustomViewCallback sairDaTelaCheia;
    private Cromo cromo;

    /** Ponte.girar: trava a orientação só durante a tela cheia; fora dela, só destrava. */
    void girar(int orientacao) {
        if (telaCheia != null || orientacao == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED) setRequestedOrientation(orientacao);
    }

    @SuppressWarnings("deprecation")
    private void barraDeNavegacao(boolean mostrar) {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c == null) return;
            if (mostrar) c.show(WindowInsets.Type.navigationBars());
            else c.hide(WindowInsets.Type.navigationBars());
        } else {
            View d = w.getDecorView();
            int f = d.getSystemUiVisibility();
            d.setSystemUiVisibility(mostrar ? f & ~View.SYSTEM_UI_FLAG_HIDE_NAVIGATION : f | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    /**
     * A sala não abriu: a tela de erro do Vcall (assets/erro.html, a mesma do
     * app de mesa) no lugar da página da Cloudflare ou da tela cinza do WebView.
     * Código HTTP positivo; erro de rede do WebView (ERROR_*) negativo.
     */
    private void mostrarErro(Uri sala, int codigo) {
        String tipo;
        if (!temInternet()) tipo = "internet";
        else if (codigo == WebViewClient.ERROR_TIMEOUT || codigo == 504 || codigo == 524) tipo = "demora";
        else if (codigo < 0 || codigo == 502 || codigo == 503 || codigo == 530 || (codigo >= 520 && codigo <= 527)) tipo = "tunel";
        else tipo = "servidor";
        // Túnel que sumiu não volta com o mesmo endereço: sai dos recentes.
        if (tipo.equals("tunel")) Recentes.esquecerServidor(this, sala.getScheme() + "://" + sala.getAuthority() + "/");
        web.loadUrl("https://" + HOST_LOCAL + "/erro.html?tipo=" + tipo + "&codigo=" + codigo
                + "&url=" + Uri.encode(sala.toString()));
    }

    private boolean temInternet() {
        android.net.ConnectivityManager cm = getSystemService(android.net.ConnectivityManager.class);
        android.net.Network rede = cm == null ? null : cm.getActiveNetwork();
        android.net.NetworkCapabilities cap = rede == null ? null : cm.getNetworkCapabilities(rede);
        return cap != null && cap.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    /* ------------------------------------------------------------------ *
     * Permissões de câmera e microfone
     * ------------------------------------------------------------------ */

    private void pedirPermissoes(PermissionRequest req) {
        if (naTelaInicial) {
            req.deny();
            return;
        }
        List<String> faltam = new ArrayList<>();
        for (String r : req.getResources()) {
            String p = permissaoDe(r);
            if (p != null && checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) faltam.add(p);
        }
        if (faltam.isEmpty()) {
            concederOQueDa(req);
            return;
        }
        // A notificação da chamada em andamento (Android 13+) entra no mesmo pedido.
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            faltam.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (pedidoPendente != null) pedidoPendente.deny();
        pedidoPendente = req;
        requestPermissions(faltam.toArray(new String[0]), PEDIDO_PERMISSOES);
    }

    private static String permissaoDe(String recurso) {
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(recurso)) return Manifest.permission.CAMERA;
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(recurso)) return Manifest.permission.RECORD_AUDIO;
        return null;
    }

    /** Concede só câmera/microfone, e só o que o Android já liberou. */
    private void concederOQueDa(PermissionRequest req) {
        List<String> ok = new ArrayList<>();
        for (String r : req.getResources()) {
            String p = permissaoDe(r);
            if (p != null && checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) ok.add(r);
        }
        if (ok.isEmpty()) req.deny();
        else req.grant(ok.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int codigo, String[] perms, int[] res) {
        if (codigo != PEDIDO_PERMISSOES || pedidoPendente == null) return;
        PermissionRequest req = pedidoPendente;
        pedidoPendente = null;
        concederOQueDa(req);
        // Câmera ou microfone liberados no meio da chamada: o serviço começa
        // (entrou com as duas recusadas) ou ganha o tipo novo (startForeground de novo).
        if (emChamada) ChamadaService.iniciar(this);
    }

    @Override
    protected void onActivityResult(int codigo, int resultado, Intent dados) {
        if (codigo != PEDIDO_ARQUIVO || arquivoPendente == null) return;
        Uri[] uris = null;
        if (resultado == RESULT_OK && dados != null) {
            if (dados.getClipData() != null) {
                uris = new Uri[dados.getClipData().getItemCount()];
                for (int i = 0; i < uris.length; i++) uris[i] = dados.getClipData().getItemAt(i).getUri();
            } else if (dados.getData() != null) {
                uris = new Uri[] {dados.getData()};
            }
        }
        arquivoPendente.onReceiveValue(uris);
        arquivoPendente = null;
    }

    /* ------------------------------------------------------------------ *
     * Chamada em andamento: serviço, tela acesa, volume, mini-janela
     * ------------------------------------------------------------------ */

    /** Chamado pela página (injetar.js) quando a pessoa entra ou sai da sala. */
    void chamada(boolean ligada) {
        if (ligada == emChamada) return;
        emChamada = ligada;
        Window w = getWindow();
        if (ligada) {
            w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            setVolumeControlStream(AudioManager.STREAM_VOICE_CALL);
            ChamadaService.iniciar(this);
        } else {
            w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            setVolumeControlStream(AudioManager.USE_DEFAULT_STREAM_TYPE);
            ChamadaService.parar(this);
        }
        if (Build.VERSION.SDK_INT >= 26) atualizarMiniJanela();
    }

    private PictureInPictureParams paramsMiniJanela() {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(9, 16));
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(emChamada).setSeamlessResizeEnabled(false);
        return b.build();
    }

    private void atualizarMiniJanela() {
        try {
            setPictureInPictureParams(paramsMiniJanela());
        } catch (Exception ignorado) {
            // aparelho sem picture-in-picture
        }
    }

    private boolean entrarNaMiniJanela() {
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return false;
        try {
            return enterPictureInPictureMode(paramsMiniJanela());
        } catch (Exception e) {
            return false;
        }
    }

    /** Botão "início" no meio da chamada: vira mini-janela (Android 11 e antes). */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (emChamada && Build.VERSION.SDK_INT < 31) entrarNaMiniJanela();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean ligada, Configuration nova) {
        super.onPictureInPictureModeChanged(ligada, nova);
        naMiniJanela = ligada;
        web.evaluateJavascript("window.__vcallMini && window.__vcallMini(" + ligada + ")", null);
    }

    /* ------------------------------------------------------------------ *
     * Voltar, convites, sair
     * ------------------------------------------------------------------ */

    private void voltar() {
        if (telaCheia != null) {
            cromo.onHideCustomView(); // voltar sai da tela cheia, não da chamada
        } else if (emChamada) {
            // Voltar não derruba a chamada: ela vai para a mini-janela.
            if (!entrarNaMiniJanela()) moveTaskToBack(true);
        } else if (web.canGoBack()) {
            web.goBack();
        } else if (!naTelaInicial) {
            web.loadUrl(INICIO);
        } else {
            finish();
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        voltar(); // até o Android 12; do 13 em diante vem pelo OnBackInvokedDispatcher
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        tratarIntent(intent);
    }

    /** Devolve true se a intent abriu (ou vai abrir) uma sala. */
    private boolean tratarIntent(Intent intent) {
        if (intent == null) return false;
        if (ACAO_INSTALACAO.equals(intent.getAction())) {
            resultadoDaInstalacao(intent);
            return false; // a tela segue onde estava (ou abre no início)
        }
        if (ACAO_SAIR.equals(intent.getAction())) {
            web.loadUrl(INICIO);
            return true;
        }
        String texto = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            texto = intent.getData().toString();
        } else if (Intent.ACTION_SEND.equals(intent.getAction())) {
            texto = intent.getStringExtra(Intent.EXTRA_TEXT);
        } else {
            return false;
        }
        String sala = Links.paraSala(texto);
        if (sala == null) {
            Toast.makeText(this, "Não achei um link de chamada do Vcall nisso.", Toast.LENGTH_LONG).show();
            return false;
        }
        abrirSala(sala);
        return true;
    }

    /** O instalador do sistema devolve aqui: pedir confirmação, ou dizer por que não deu. */
    @SuppressWarnings("deprecation")
    private void resultadoDaInstalacao(Intent intent) {
        int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmar = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmar != null) startActivity(confirmar.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } else if (st != PackageInstaller.STATUS_SUCCESS) {
            if (st == PackageInstaller.STATUS_FAILURE_ABORTED) Atualizador.cancelada(this);
            else Atualizador.falhou(this, "Não deu para atualizar. Tente de novo.");
        }
    }

    /** Leva o app para a sala. No meio de outra chamada, pergunta antes. */
    void abrirSala(String url) {
        if (emChamada && web.getUrl() != null && !web.getUrl().equals(url)) {
            linkPendente = url;
            new AlertDialog.Builder(this)
                    .setTitle("Trocar de chamada?")
                    .setMessage("Você sai da chamada atual e entra na nova.")
                    .setPositiveButton("Trocar", (d, w) -> carregarSala(linkPendente))
                    .setNegativeButton("Ficar", null)
                    .show();
            return;
        }
        carregarSala(url);
    }

    private void carregarSala(String url) {
        Recentes.guardar(this, url);
        naTelaInicial = false;
        web.loadUrl(url);
    }

    void voltarAoInicio() {
        web.loadUrl(INICIO);
    }

    void abrirFora(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (Exception e) {
            Toast.makeText(this, "Nenhum app abre esse link.", Toast.LENGTH_SHORT).show();
        }
    }

    /* ------------------------------------------------------------------ *
     * Bordas da tela e cor das barras do sistema
     * ------------------------------------------------------------------ */

    /**
     * Tela cheia: a barra de notificações some (volta deslizando de cima) e a
     * página vai até a borda, inclusive na área da câmera. Quem desvia do
     * recorte da câmera é a própria página (viewport-fit=cover e
     * env(safe-area-inset-*)): o WebView recebe só o recorte. Embaixo fica a
     * margem da barra de navegação e do teclado.
     */
    private void ajustarBordas() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            raiz.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets nav = insets.getInsets(WindowInsets.Type.navigationBars());
                Insets teclado = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(nav.left, 0, nav.right, Math.max(nav.bottom, teclado.bottom));
                return new WindowInsets.Builder(insets)
                        .setInsets(WindowInsets.Type.navigationBars(), Insets.NONE)
                        .setInsets(WindowInsets.Type.statusBars(), Insets.NONE)
                        .setInsets(WindowInsets.Type.ime(), Insets.NONE)
                        .build();
            });
        }
        esconderBarraDeNotificacoes();
    }

    @SuppressWarnings("deprecation")
    private void esconderBarraDeNotificacoes() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c == null) return;
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsets.Type.statusBars());
        } else {
            View d = w.getDecorView();
            d.setSystemUiVisibility(d.getSystemUiVisibility()
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    /** Diálogos do sistema (permissões, instalar) trazem a barra de volta. */
    @Override
    public void onWindowFocusChanged(boolean comFoco) {
        super.onWindowFocusChanged(comFoco);
        if (comFoco) esconderBarraDeNotificacoes();
    }

    /** A página avisa a cor do fundo dela (meta theme-color); as barras acompanham. */
    void corDaPagina(int cor) {
        raiz.setBackgroundColor(cor);
        boolean clara = Color.luminance(cor) > 0.5f;
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            int claras = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            w.getInsetsController().setSystemBarsAppearance(clara ? claras : 0, claras);
        } else {
            w.setStatusBarColor(cor);
            w.setNavigationBarColor(cor);
            int f = w.getDecorView().getSystemUiVisibility();
            int luz = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            w.getDecorView().setSystemUiVisibility(clara ? (f | luz) : (f & ~luz));
        }
    }

    private int corDoFundo() {
        boolean escuro = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        return escuro ? 0xFF0C0E13 : 0xFFF5F6F9;
    }

    /* ------------------------------------------------------------------ *
     * Ciclo de vida
     * ------------------------------------------------------------------ */

    @Override
    protected void onPause() {
        super.onPause();
        // Fora de chamada, a página dorme. Na chamada (inclusive na mini-janela), não.
        if (!emChamada) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        ChamadaService.parar(this);
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /* ------------------------------------------------------------------ */

    String versao() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    void evaluar(String js) {
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    private String lerAsset(String nome) {
        try (InputStream in = getAssets().open(nome)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } catch (IOException e) {
            throw new IllegalStateException(nome + " faltando no APK", e);
        }
    }

    private static String tipo(String caminho) {
        if (caminho.endsWith(".html")) return "text/html";
        if (caminho.endsWith(".js")) return "text/javascript";
        if (caminho.endsWith(".css")) return "text/css";
        if (caminho.endsWith(".svg")) return "image/svg+xml";
        if (caminho.endsWith(".woff2")) return "font/woff2";
        if (caminho.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }
}
