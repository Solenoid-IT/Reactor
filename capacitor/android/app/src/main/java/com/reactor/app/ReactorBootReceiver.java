package com.reactor.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

public class ReactorBootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) {
            return;
        }

        String action = intent != null ? intent.getAction() : "";
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }

        SharedPreferences prefs = context.getSharedPreferences(ReactorHttpService.PREFS_NAME, Context.MODE_PRIVATE);
        int configuredPort = prefs.getInt(ReactorHttpService.PREF_HTTP_PORT, ReactorHttpService.DEFAULT_PORT);
        if (configuredPort < 1 || configuredPort > 65535) {
            configuredPort = ReactorHttpService.DEFAULT_PORT;
        }

        Intent serviceIntent = new Intent(context, ReactorHttpService.class);
        serviceIntent.setAction(ReactorHttpService.ACTION_START);
        serviceIntent.putExtra(ReactorHttpService.EXTRA_PORT, configuredPort);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent);
        } else {
            context.startService(serviceIntent);
        }

        ReactorServiceWatchdogWorker.schedule(context);
    }
}