import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.closetiq.app',
  appName: 'ClosetIQ',
  webDir: 'dist',
  android: {
    // Never load content over plain HTTP, and don't let Chrome devtools attach to release builds.
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#4f46e5',
      showSpinner: false,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_closetiq',
      iconColor: '#4f46e5',
    },
  },
}

export default config
