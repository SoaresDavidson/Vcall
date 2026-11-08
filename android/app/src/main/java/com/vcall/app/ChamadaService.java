package com.vcall.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.IBinder;

/**
 * "Chamada em andamento" na barra de notificações.
 *
 * Sem um serviço em primeiro plano, o Android corta câmera e microfone de
 * quem sai do app (Android 9+ para câmera, 11+ para microfone): a pessoa
 * abria o WhatsApp no meio da chamada e os outros paravam de ouvi-la.
 */
public class ChamadaService extends Service {
    private static final String CANAL = "chamada-ativa";
    private static final int ID = 1;

    /** Tipos de serviço que o Android já liberou: microfone e câmera com a permissão concedida. */
    static int tipos(Context c) {
        int t = 0;
        if (c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
            t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        if (c.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
            t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        return t;
    }

    /**
     * Sem câmera nem microfone liberados não há o que manter, e o serviço nem
     * começa: iniciado por startForegroundService, ele TEM de chamar
     * startForeground a tempo, e o stopSelf no lugar não basta — o Android
     * matava o app (ForegroundServiceDidNotStartInTimeException) de quem
     * entrava na chamada com as duas permissões recusadas. Se a permissão vier
     * depois, MainActivity.onRequestPermissionsResult chama de novo.
     */
    static void iniciar(Context c) {
        if (Build.VERSION.SDK_INT >= 29 && tipos(c) == 0) return;
        Intent i = new Intent(c, ChamadaService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Exception ignorado) {
            // sem permissão de câmera/microfone ainda: a página roda sem o serviço
        }
    }

    static void parar(Context c) {
        c.stopService(new Intent(c, ChamadaService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CANAL) == null) {
            // Importância padrão, mas muda: com "baixa" ela ia para "Silenciosas", recolhida.
            NotificationChannel canal = new NotificationChannel(CANAL, "Chamada em andamento", NotificationManager.IMPORTANCE_DEFAULT);
            canal.setSound(null, null);
            canal.enableVibration(false);
            canal.setShowBadge(false);
            nm.createNotificationChannel(canal);
        }

        int imutavel = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        Intent voltar = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent sair = PendingIntent.getActivity(this, 1,
                new Intent(this, MainActivity.class).setAction(MainActivity.ACAO_SAIR).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                imutavel);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CANAL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_launcher_monochrome)
                .setContentTitle("Chamada em andamento")
                .setContentText("Toque para voltar à chamada")
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_CALL)
                .setContentIntent(PendingIntent.getActivity(this, 0, voltar, imutavel));
        if (Build.VERSION.SDK_INT >= 31) {
            // Estilo de chamada: fica no topo da gaveta, com o "desligar" sempre à mostra.
            Person quem = new Person.Builder().setName("Chamada em andamento").setImportant(true)
                    .setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher)).build();
            b.setStyle(Notification.CallStyle.forOngoingCall(quem, sair));
        } else {
            b.addAction(new Notification.Action.Builder(null, "Sair da chamada", sair).build());
        }

        if (Build.VERSION.SDK_INT >= 29) {
            // Só os tipos que o Android já liberou; pedir câmera sem a permissão derruba o serviço (14+).
            int tipos = tipos(this);
            if (tipos == 0) { // permissão retirada entre o iniciar() e aqui
                stopSelf();
                return START_NOT_STICKY;
            }
            startForeground(ID, b.build(), tipos);
        } else {
            startForeground(ID, b.build());
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
