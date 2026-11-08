package com.vcall.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * window.VcallAndroid: o que a página pede ao Android.
 *
 * Estes métodos rodam numa thread do WebView, e QUALQUER página aberta no app
 * os enxerga — inclusive uma que alguém mande como "convite". Por isso o que
 * mexe em navegação ou lê a área de transferência só vale na tela inicial
 * (que é nossa), e salvar arquivo só escreve em Downloads/Vcall.
 */
final class Ponte {
    private final MainActivity tela;
    private final Map<Integer, Arquivo> abertos = new HashMap<>();
    private int proximo = 1;

    Ponte(MainActivity tela) {
        this.tela = tela;
    }

    /* --- tela inicial --- */

    @JavascriptInterface
    public boolean entrar(String texto) {
        if (!tela.naTelaInicial) return false;
        String sala = Links.paraSala(texto);
        if (sala == null) return false;
        tela.runOnUiThread(() -> tela.abrirSala(sala));
        return true;
    }

    /** Lê a área de transferência a pedido (botão "Colar") e devolve à página. */
    @JavascriptInterface
    public void pedirColagem() {
        if (!tela.naTelaInicial) return;
        tela.runOnUiThread(() -> {
            ClipboardManager cm = tela.getSystemService(ClipboardManager.class);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            CharSequence t = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(tela) : "";
            tela.evaluar("window.receberColagem && window.receberColagem(" + JSONObject.quote(String.valueOf(t)) + ")");
        });
    }

    @JavascriptInterface
    public String recentes() {
        return tela.naTelaInicial ? Recentes.lista(tela) : "[]";
    }

    @JavascriptInterface
    public void esquecer(String url) {
        if (tela.naTelaInicial) Recentes.esquecer(tela, url);
    }

    @JavascriptInterface
    public String versao() {
        return tela.versao();
    }

    /** Estado da atualização; ao abrir a tela inicial, também procura (de 6 em 6 horas). */
    @JavascriptInterface
    public String atualizacao() {
        if (!tela.naTelaInicial) return "{}";
        Atualizador.procurar(tela, false);
        return Atualizador.estado();
    }

    @JavascriptInterface
    public void procurarAtualizacao() {
        if (tela.naTelaInicial) Atualizador.procurar(tela, true);
    }

    @JavascriptInterface
    public boolean instalarAtualizacao() {
        return tela.naTelaInicial && Atualizador.instalar(tela);
    }

    /* --- tela de erro (assets/erro.html) --- */

    /** A sala voltou? Responde em window.aoSondar(status HTTP), 0 se não respondeu. */
    @JavascriptInterface
    public void sondar(String url) {
        if (!tela.naTelaInicial) return;
        String sala = Links.paraSala(url);
        new Thread(() -> {
            int status = 0;
            if (sala != null) {
                try {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                            new java.net.URL(android.net.Uri.parse(sala).buildUpon().path("/healthz").fragment(null).build().toString())
                                    .openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    status = c.getResponseCode();
                    c.disconnect();
                } catch (Exception ignorado) {
                    // sem resposta: continua 0
                }
            }
            tela.evaluar("window.aoSondar && window.aoSondar(" + status + ")");
        }, "vcall-sondar").start();
    }

    /** Qualquer página pode pedir para voltar ao início do app (é nosso, não leva a lugar nenhum de fora). */
    @JavascriptInterface
    public void voltarAoInicio() {
        tela.runOnUiThread(tela::voltarAoInicio);
    }

    /** A paleta e o tema escolhidos na sala, para a tela de erro abrir igual. */
    @JavascriptInterface
    public void lembrarTema(String paleta, String tema) {
        String p = paleta == null ? "" : paleta;
        String t = tema == null ? "" : tema;
        if (!p.matches("[a-z-]{0,24}") || !t.matches("(dark|light)?")) return;
        tela.getSharedPreferences("tema", android.content.Context.MODE_PRIVATE).edit()
                .putString("paleta", p).putString("tema", t).apply();
    }

    @JavascriptInterface
    public String tema() {
        android.content.SharedPreferences sp = tela.getSharedPreferences("tema", android.content.Context.MODE_PRIVATE);
        try {
            return new JSONObject().put("paleta", sp.getString("paleta", "")).put("tema", sp.getString("tema", "")).toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /* --- página da chamada (injetar.js) --- */

    @JavascriptInterface
    public void chamada(boolean ligada) {
        tela.runOnUiThread(() -> tela.chamada(ligada));
    }

    /**
     * A tela compartilhada em tela cheia gira o celular (ui/stage.js):
     * "paisagem", "retrato" ou "" (volta a girar livre). O WebView não tem
     * screen.orientation.lock. Só vale durante a tela cheia (MainActivity.girar).
     */
    @JavascriptInterface
    public void girar(String orientacao) {
        int o = "paisagem".equals(orientacao) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : "retrato".equals(orientacao) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        tela.runOnUiThread(() -> tela.girar(o));
    }

    @JavascriptInterface
    public void corDaPagina(String cor) {
        try {
            int c = Color.parseColor(cor.trim());
            tela.runOnUiThread(() -> tela.corDaPagina(c));
        } catch (Exception ignorado) {
            // cor que o Android não lê (rgb(), var()…): fica a de antes
        }
    }

    /*
     * Download de arquivo feito na página (blob:). Vem em pedaços de base64:
     * um arquivo de 25 MB numa string só pesaria 33 MB de uma vez na ponte.
     */

    @JavascriptInterface
    public int abrirArquivo(String nome, String mime) {
        String limpo = nome == null ? "" : nome.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (limpo.isEmpty() || limpo.startsWith(".")) limpo = "arquivo-vcall" + limpo;
        if (limpo.length() > 120) limpo = limpo.substring(limpo.length() - 120);
        String tipo = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
        try {
            Arquivo a = Build.VERSION.SDK_INT >= 29 ? novoEmDownloads(limpo, tipo) : novoNaPastaDoApp(limpo);
            synchronized (abertos) {
                abertos.put(proximo, a);
                return proximo++;
            }
        } catch (Exception e) {
            avisar("Não deu para salvar “" + limpo + "”.");
            return 0;
        }
    }

    @JavascriptInterface
    public boolean escreverArquivo(int id, String base64) {
        Arquivo a;
        synchronized (abertos) {
            a = abertos.get(id);
        }
        if (a == null) return false;
        try {
            a.saida.write(Base64.decode(base64, Base64.DEFAULT));
            return true;
        } catch (Exception e) {
            fechar(id, false);
            return false;
        }
    }

    @JavascriptInterface
    public void fecharArquivo(int id) {
        fechar(id, true);
    }

    private void fechar(int id, boolean ok) {
        Arquivo a;
        synchronized (abertos) {
            a = abertos.remove(id);
        }
        if (a == null) return;
        try {
            a.saida.close();
            if (a.uri != null) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                if (ok) tela.getContentResolver().update(a.uri, v, null, null);
                else tela.getContentResolver().delete(a.uri, null, null);
            }
            avisar(ok ? "“" + a.nome + "” salvo em " + a.onde : "Não deu para salvar “" + a.nome + "”.");
        } catch (Exception e) {
            avisar("Não deu para salvar “" + a.nome + "”.");
        }
    }

    private Arquivo novoEmDownloads(String nome, String tipo) throws Exception {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, nome);
        v.put(MediaStore.MediaColumns.MIME_TYPE, tipo);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Vcall");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = tela.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new IllegalStateException("sem Downloads");
        OutputStream out = tela.getContentResolver().openOutputStream(uri);
        if (out == null) throw new IllegalStateException("sem saída");
        return new Arquivo(nome, uri, out, "Downloads/Vcall");
    }

    /** Android 8 e 9: sem permissão de armazenamento, fica na pasta do app. */
    private Arquivo novoNaPastaDoApp(String nome) throws Exception {
        File pasta = tela.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (pasta == null) throw new IllegalStateException("sem armazenamento");
        File f = new File(pasta, nome);
        return new Arquivo(nome, null, new FileOutputStream(f), "Android/data/" + tela.getPackageName() + "/files/Download");
    }

    private void avisar(String texto) {
        tela.runOnUiThread(() -> Toast.makeText(tela, texto, Toast.LENGTH_LONG).show());
    }

    private static final class Arquivo {
        final String nome;
        final Uri uri;
        final OutputStream saida;
        final String onde;

        Arquivo(String nome, Uri uri, OutputStream saida, String onde) {
            this.nome = nome;
            this.uri = uri;
            this.saida = saida;
            this.onde = onde;
        }
    }
}
