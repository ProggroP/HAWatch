/* FFI GENERATED FILE; DO NOT EDIT! */

#include "xsffi.h"

txAPI* XS = NULL;

extern int32_t health_steps_today();
extern int32_t health_distance_today();
extern int32_t clock_is_24h();

static void xs_health_steps_today(txMachine* the) {
	int32_t result = health_steps_today();
	XS->fromInteger(the, mxResult, (txInteger)result);
}

static void xs_health_distance_today(txMachine* the) {
	int32_t result = health_distance_today();
	XS->fromInteger(the, mxResult, (txInteger)result);
}

static void xs_clock_is_24h(txMachine* the) {
	int32_t result = clock_is_24h();
	XS->fromInteger(the, mxResult, (txInteger)result);
}

void fxBuildFFI(txMachine* the, txAPI* api) {
	XS = api;
	XS->newHostFunction(the, xs_health_steps_today, 0, 0, 0);
	XS->push(the, mxThis);
	XS->defineID(the, XS->id(the, "health_steps_today"), 0, 0x0E);
	XS->pop(the);
	XS->newHostFunction(the, xs_health_distance_today, 0, 0, 0);
	XS->push(the, mxThis);
	XS->defineID(the, XS->id(the, "health_distance_today"), 0, 0x0E);
	XS->pop(the);
	XS->newHostFunction(the, xs_clock_is_24h, 0, 0, 0);
	XS->push(the, mxThis);
	XS->defineID(the, XS->id(the, "clock_is_24h"), 0, 0x0E);
	XS->pop(the);
}
