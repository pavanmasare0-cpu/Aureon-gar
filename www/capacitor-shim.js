// Placeholder for native Capacitor plugin wiring (Preferences, Filesystem, Camera, etc).
// Safe no-op today — add real plugin imports here as you add native features
// e.g. `npm install @capacitor/preferences` then wire it in here.
window.AureonNative = {
  available: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
};
