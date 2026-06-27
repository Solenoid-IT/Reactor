import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.reactor.app',
  appName: 'Reactor',
  webDir: 'ui/build',
  android: {
    path: 'dist/mobile/android'
  }
};

export default config;
