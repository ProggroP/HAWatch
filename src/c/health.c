// Schritte und Distanz vom Health-Service der Uhr.
//
// Der Moddable-Teil (src/embeddedjs) hat kein Health-Modul. Der Weg dorthin
// fuehrt ueber die FFI-Bruecke: in src/embeddedjs/manifest.json stehen die
// beiden Funktionen unter "ffi" -> "functions", daraus erzeugt mcrun beim Bauen
// src/c/mc.ffi.c, und die dort erzeugte fxBuildFFI() haengt sie an das
// FFI-Objekt, das main.js mit `new FFI()` anlegt.
//
// Beide Funktionen liefern -1, solange keine Gesundheitsdaten vorliegen -- das
// ist etwas anderes als 0 Schritte und wird in main.js als "---" gezeichnet.

#include <pebble.h>

#define HEALTH_UNAVAILABLE (-1)

static bool prv_metric_available(HealthMetric metric) {
  const time_t now   = time(NULL);
  const time_t start = time_start_of_today();
  return health_service_metric_accessible(metric, start, now)
         & HealthServiceAccessibilityMaskAvailable;
}

int32_t health_steps_today(void) {
  if (!prv_metric_available(HealthMetricStepCount)) return HEALTH_UNAVAILABLE;
  return (int32_t)health_service_sum_today(HealthMetricStepCount);
}

// Rueckgabe in Metern; main.js rechnet auf Kilometer um.
int32_t health_distance_today(void) {
  if (!prv_metric_available(HealthMetricWalkedDistanceMeters)) return HEALTH_UNAVAILABLE;
  return (int32_t)health_service_sum_today(HealthMetricWalkedDistanceMeters);
}
