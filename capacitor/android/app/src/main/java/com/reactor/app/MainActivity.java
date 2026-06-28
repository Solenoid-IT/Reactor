package com.reactor.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(ReactorMobilePlugin.class);
		super.onCreate(savedInstanceState);
		ReactorServiceWatchdogWorker.schedule(getApplicationContext());
	}
}
