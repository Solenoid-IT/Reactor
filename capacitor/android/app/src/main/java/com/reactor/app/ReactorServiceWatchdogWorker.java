package com.reactor.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

public class ReactorServiceWatchdogWorker extends Worker {
    public static final String UNIQUE_WORK_NAME = "reactor-service-watchdog";

    public ReactorServiceWatchdogWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = context.getSharedPreferences(ReactorHttpService.PREFS_NAME, Context.MODE_PRIVATE);

        int configuredPort = prefs.getInt(ReactorHttpService.PREF_HTTP_PORT, ReactorHttpService.DEFAULT_PORT);
        if (configuredPort < 1 || configuredPort > 65535) {
            configuredPort = ReactorHttpService.DEFAULT_PORT;
        }

        Intent serviceIntent = new Intent(context, ReactorHttpService.class);
        serviceIntent.setAction(ReactorHttpService.ACTION_START);
        serviceIntent.putExtra(ReactorHttpService.EXTRA_PORT, configuredPort);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            return Result.success();
        } catch (Throwable error) {
            return Result.retry();
        }
    }

    public static void schedule(Context context) {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(ReactorServiceWatchdogWorker.class, 15, TimeUnit.MINUTES)
                .setInitialDelay(1, TimeUnit.MINUTES)
                .build();

        WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(UNIQUE_WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    public static void cancel(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_WORK_NAME);
    }
}