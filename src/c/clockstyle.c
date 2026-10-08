// Zeitformat der Uhr.
//
// Der Moddable-Teil (src/embeddedjs) kommt an die Systemeinstellungen der Uhr
// nicht heran. Der Weg dorthin fuehrt wie bei den Gesundheitsdaten ueber die
// FFI-Bruecke: die Funktion steht in src/embeddedjs/manifest.json unter "ffi"
// -> "functions", daraus erzeugt mcrun beim Bauen src/c/mc.ffi.c, und die dort
// erzeugte fxBuildFFI() haengt sie an das FFI-Objekt, das main.js mit
// `new FFI()` anlegt.
//
// Der eigene Name ist noetig, weil clock_is_24h_style() bereits vom SDK kommt.

#include <pebble.h>

// 1, wenn in den Uhreinstellungen das 24-Stunden-Format aktiv ist, sonst 0.
int32_t clock_is_24h(void) {
  return clock_is_24h_style() ? 1 : 0;
}
