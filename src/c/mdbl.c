// Einstiegspunkt der Watchapp. Die eigentliche Logik liegt in
// src/embeddedjs/main.js; hier wird nur die XS-Maschine gestartet.
//
// fxBuildFFI ist in dem beim Bauen erzeugten src/c/mc.ffi.c definiert (deklariert
// wird es von xsffi.h, das pebble.h mitbringt) und macht die Funktionen aus
// health.c fuer JavaScript erreichbar. Ohne diesen Zeiger im
// ModdableCreationRecord liefert `new FFI()` in main.js undefined.

#include <pebble.h>

int main(void) {
  Window *window = window_create();
  window_stack_push(window, true);

  ModdableCreationRecord creation = {
    .recordSize = sizeof(ModdableCreationRecord),
    .fxBuildFFI = fxBuildFFI,
  };
  moddable_createMachine(&creation);

  window_destroy(window);
}
