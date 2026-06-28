import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.reactor.app',
  appName: 'Reactor',
  webDir: 'ui/build',
  android: {
    path: 'capacitor/android'
  }
};

export default config;
