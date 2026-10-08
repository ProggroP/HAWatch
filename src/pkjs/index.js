// PebbleKit JS: laeuft auf dem Telefon, holt die konfigurierten Werte aus Home
// Assistant sowie das Wetter und schickt beides an die Uhr.
//
// Schritte, Distanz, Ladestand sowie Sonnenauf- und -untergang rechnet die Uhr
// selbst aus -- die tauchen hier nicht auf.

var Clay = require('@rebble/clay');
var clayConfig = require('./config');

// autoHandleEvents ist aus, weil keiner der Konfigurationswerte auf die Uhr
// gehoert: URL, Token und Entity-IDs bleiben auf dem Telefon. Clays
// automatischer Handler wuerde versuchen, sie zu senden, und daran scheitern,
// dass sie in package.json gar nicht als messageKeys stehen.
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var REFRESH_INTERVAL_MS = 5 * 60 * 1000;
var REQUEST_TIMEOUT_MS  = 15 * 1000;

// Der Standort wird hoechstens einmal pro Stunde neu bestimmt; fuer Sonnenauf-
// und -untergang reicht das bei weitem und schont den Akku des Telefons.
var LOCATION_MAX_AGE_MS = 60 * 60 * 1000;

// Das Wetter aendert sich langsamer als die HA-Sensoren.
var WEATHER_MAX_AGE_MS = 15 * 60 * 1000;

var CACHE_KEY = 'ha-watch-cache';

var ERROR_UNREACHABLE = 'HA not reachable';

// Der Standort geht als Ganzzahl mit fuenf Nachkommastellen auf die Uhr, weil
// AppMessage keine Gleitkommazahlen kennt. Er wird fuer Sonnenauf- und
// -untergang sowie fuer das Wetter gebraucht.
var COORDINATE_SCALE = 100000;

// Mittelpunkt Deutschlands, solange das Telefon noch keine Position geliefert
// hat -- dieselbe Notloesung wie auf der Uhr.
var FALLBACK_LATITUDE  = 51.16;
var FALLBACK_LONGITUDE = 10.45;

// -------------------------------------------------------------------
// Zeilen und Slots
// -------------------------------------------------------------------
// Drei konfigurierbare Zeilen mit je zwei Slots. Die Nummern sind zugleich die
// Nummern in den AppMessage-Schluesseln value1..value6.
//
// Die mittlere Zeile behaelt die Slots 1 und 2, weil das in Version 1.1 die
// einzigen beiden Sensoren waren und sie an genau dieser Stelle standen. Damit
// bleiben auch die Clay-Schluessel entity1/unit1/entity2/unit2 gueltig und
// niemand muss nach dem Update etwas neu eintragen.
var ROW_TOP    = 0;
var ROW_MIDDLE = 1;
var ROW_BOTTOM = 2;
var ROW_SLOTS  = [['3', '4'], ['1', '2'], ['5', '6']];
var ALL_SLOTS  = ['1', '2', '3', '4', '5', '6'];

// Die Wettervorgabe steht nur in der mittleren Zeile.
var WEATHER_ROW = ROW_MIDDLE;

var ROW_MODE_BITS = 2;

// -------------------------------------------------------------------
// Zwischenspeicher
// -------------------------------------------------------------------
// Zuletzt gesendeter Stand. Er wird gespeichert, damit die Uhr nach einem
// Neustart sofort etwas anzeigt statt "--".
var CACHE_DEFAULTS = {
    latitude: null, longitude: null,
    weather: '', temperature: '', tempunit: '',
    rowmode: 0,
    // 0 heisst "wie die Uhr eingestellt ist", 24 und 12 erzwingen das Format.
    timeformat: 0,
    // Siehe DATE_FORMAT_CODES; 1 ist "Tue, 25 Aug".
    dateformat: 1
};
ALL_SLOTS.forEach(function(suffix) {
    CACHE_DEFAULTS['value' + suffix] = '';
    CACHE_DEFAULTS['unit'  + suffix] = '';
});

var cache = loadCache();
var weatherFetchedAt = 0;

// Feldweise zusammengesetzt, damit ein Zwischenspeicher aus Version 1.1 -- der
// nur value1/value2 und den Standort kennt -- ohne Sonderfall weiterlebt.
function loadCache() {
    var stored = null;
    try {
        stored = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    } catch (e) {
        stored = null;
    }

    var result = {};
    Object.keys(CACHE_DEFAULTS).forEach(function(key) {
        var value = stored ? stored[key] : undefined;
        result[key] = (value === undefined || value === null)
                    ? CACHE_DEFAULTS[key] : value;
    });
    return result;
}

function saveCache() {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

// -------------------------------------------------------------------
// Einstellungen
// -------------------------------------------------------------------
function readSettings() {
    var stored = {};
    try {
        stored = JSON.parse(localStorage.getItem('clay-settings') || '{}') || {};
    } catch (e) {
        stored = {};
    }

    function text(key) {
        return String(stored[key] === undefined || stored[key] === null ? '' : stored[key]).trim();
    }

    var settings = {
        // Ein abschliessender Schraegstrich wuerde zu "//api/states/..." fuehren.
        url:        text('haUrl').replace(/\/+$/, ''),
        token:      text('haToken'),
        tempUnit:   text('tempUnit')   || 'auto',
        timeFormat: text('timeFormat') || 'watch',
        dateFormat: text('dateFormat') || 'auto'
    };

    ALL_SLOTS.forEach(function(suffix) {
        settings['entity' + suffix] = text('entity' + suffix);
        settings['unit'   + suffix] = text('unit'   + suffix);
    });

    return settings;
}

// -------------------------------------------------------------------
// Zeitformat
// -------------------------------------------------------------------
// "watch" heisst: die Uhr entscheidet selbst anhand ihrer eigenen Einstellung
// (clock_is_24h_style() ueber die FFI-Bruecke). Das Telefon schickt dann eine
// 0 und mischt sich nicht ein.
function timeFormatCode(settings) {
    if ('24' === settings.timeFormat) return 24;
    if ('12' === settings.timeFormat) return 12;
    return 0;
}

// -------------------------------------------------------------------
// Datumsformat
// -------------------------------------------------------------------
// Die Uhr kennt nur Zahlen; das Gebietsschema wird hier aufgeloest, damit dort
// keine Laendertabelle liegen muss. Die Werte muessen zu den DATE_*-Konstanten
// in src/embeddedjs/main.js passen.
var DATE_FORMAT_CODES = {
    classic:   0,   // Tu, 25. Aug   (Darstellung bis Version 1.2)
    dayMonth:  1,   // Tue, 25 Aug
    monthDay:  2,   // Tue, Aug 25
    numericDe: 3,   // Tue, 25.08.
    numericUs: 4,   // Tue, 08/25
    iso:       5    // 2026-08-25
};

// Laender, in denen der Monat vor dem Tag steht.
var MONTH_FIRST_REGIONS = /-(US|PH|FM|MH|PW)\b/i;

function regionTags() {
    var tags = [];
    if (navigator.language) tags.push(navigator.language);
    if (navigator.languages) tags = tags.concat(navigator.languages);
    return tags.join(' ');
}

function dateFormatCode(settings) {
    var chosen = DATE_FORMAT_CODES[settings.dateFormat];
    if (chosen !== undefined) return chosen;
    return MONTH_FIRST_REGIONS.test(regionTags()) ? DATE_FORMAT_CODES.monthDay
                                                  : DATE_FORMAT_CODES.dayMonth;
}

// -------------------------------------------------------------------
// Zeilenbelegung bestimmen
// -------------------------------------------------------------------
// Belegte Slots ruecken innerhalb ihrer Zeile lueckenlos nach vorne: wer nur
// den rechten Wert einer Zeile ausfuellt, bekommt ihn trotzdem als einzelnen
// Wert ueber die volle Breite. Nicht belegte Slots werden geleert, damit nach
// einer Aenderung kein alter Wert stehen bleibt.
function planRows(settings) {
    var connected = Boolean(settings.url && settings.token);
    var jobs   = [];
    var counts = [];

    ROW_SLOTS.forEach(function(slots) {
        var used = 0;

        slots.forEach(function(suffix) {
            var entity = settings['entity' + suffix];
            if (!connected || !entity) return;
            jobs.push({
                slot:   slots[used],
                entity: entity,
                unit:   settings['unit' + suffix]
            });
            used += 1;
        });

        for (var i = used; i < slots.length; i += 1) {
            cache['value' + slots[i]] = '';
            cache['unit'  + slots[i]] = '';
        }
        counts.push(used);
    });

    return { jobs: jobs, counts: counts };
}

function encodeRowMode(counts) {
    var mode = 0;
    counts.forEach(function(count, row) {
        mode |= (count & 3) << (row * ROW_MODE_BITS);
    });
    return mode;
}

// -------------------------------------------------------------------
// Werte aufbereiten
// -------------------------------------------------------------------
// Home Assistant liefert Zustaende als Zeichenkette, oft mit mehr
// Nachkommastellen als auf ein Zifferblatt passen. Nicht-Zahlen ("charging",
// "on") werden durchgereicht und nur gekuerzt.
var MAX_VALUE_LENGTH = 10;
var MAX_UNIT_LENGTH  = 6;

function formatValue(state) {
    var number = parseFloat(state);
    if (isNaN(number)) {
        return String(state).substring(0, MAX_VALUE_LENGTH);
    }
    // Ab 100 ist die Nachkommastelle Rauschen, und ein glatter Wert soll nicht
    // als "90.0" dastehen.
    var rounded = (Math.abs(number) >= 100) ? Math.round(number)
                                            : Math.round(number * 10) / 10;
    return (rounded === Math.round(rounded)) ? String(Math.round(rounded))
                                             : rounded.toFixed(1);
}

// -------------------------------------------------------------------
// Home Assistant abfragen
// -------------------------------------------------------------------
// onDone(result) wird immer genau einmal gerufen; result ist null, wenn die
// Entity nicht gelesen werden konnte.
function fetchEntity(settings, entityId, configuredUnit, onDone) {
    if (!entityId) {
        onDone({ value: '', unit: '' });
        return;
    }

    var request = new XMLHttpRequest();
    request.open('GET', settings.url + '/api/states/' + encodeURIComponent(entityId), true);
    request.setRequestHeader('Authorization', 'Bearer ' + settings.token);
    request.setRequestHeader('Content-Type', 'application/json');
    request.timeout = REQUEST_TIMEOUT_MS;

    request.onload = function() {
        if (request.status !== 200) {
            console.log('HA request failed (' + entityId + '): HTTP ' + request.status);
            onDone(null);
            return;
        }
        try {
            var data       = JSON.parse(request.responseText);
            var attributes = data.attributes || {};
            var unit       = configuredUnit || attributes.unit_of_measurement || '';
            onDone({
                value: formatValue(data.state),
                unit:  String(unit).substring(0, MAX_UNIT_LENGTH)
            });
        } catch (e) {
            console.log('answer not readable (' + entityId + '): ' + e);
            onDone(null);
        }
    };
    request.onerror   = function() { console.log('network error (' + entityId + ')');  onDone(null); };
    request.ontimeout = function() { console.log('timeout (' + entityId + ')'); onDone(null); };
    request.send();
}

function refresh() {
    var settings = readSettings();
    var plan     = planRows(settings);

    cache.rowmode    = encodeRowMode(plan.counts);
    cache.timeformat = timeFormatCode(settings);
    cache.dateformat = dateFormatCode(settings);
    maybeRefreshWeather(settings, plan.counts);

    // Nichts eingetragen heisst nicht "Fehler", sondern "alle drei Zeilen
    // zeigen ihre Vorgabe".
    if (0 === plan.jobs.length) {
        saveCache();
        publishWithError('');
        return;
    }

    var pending = plan.jobs.length;
    var failed  = 0;

    plan.jobs.forEach(function(job) {
        fetchEntity(settings, job.entity, job.unit, function(result) {
            if (result === null) {
                failed += 1;
            } else {
                cache['value' + job.slot] = result.value;
                cache['unit'  + job.slot] = result.unit;
            }
            pending -= 1;
            if (pending > 0) return;

            saveCache();
            // Nur wenn gar nichts ankam, ist die Meldung ehrlicher als ein
            // stehengebliebener alter Wert.
            publishWithError(failed === plan.jobs.length ? ERROR_UNREACHABLE : '');
        });
    });
}

// -------------------------------------------------------------------
// Wetter
// -------------------------------------------------------------------
// Open-Meteo, weil die Vorgabe auch ohne eingerichteten Home Assistant stehen
// muss: freier Dienst, kein Schluessel noetig, Daten unter CC BY 4.0.
// Wer stattdessen HA-Wetter moechte, traegt einfach eine Entity in die Zeile
// ein -- dann wird hier gar nichts abgefragt.
var WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO-Wettercodes auf kurze Bezeichnungen, die auch neben der Temperatur noch
// auf das Display passen.
var WEATHER_TEXT = {
    0: 'Clear',   1: 'Clear',    2: 'Cloudy',  3: 'Overcast',
    45: 'Fog',    48: 'Fog',
    51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
    56: 'Sleet',  57: 'Sleet',
    61: 'Rain',   63: 'Rain',    65: 'Rain',
    66: 'Sleet',  67: 'Sleet',
    71: 'Snow',   73: 'Snow',    75: 'Snow',   77: 'Snow',
    80: 'Showers', 81: 'Showers', 82: 'Showers',
    85: 'Snow',   86: 'Snow',
    95: 'Storm',  96: 'Storm',   99: 'Storm'
};

// Es gibt in PebbleKit JS keine Schnittstelle zur Einheiten-Einstellung der
// Pebble-App. Deshalb wird die Region des Telefons ausgewertet -- und wer damit
// falsch liegt, stellt es in der Konfigseite von Hand um.
var FAHRENHEIT_REGIONS = /-(US|BS|BZ|KY|FM|MH|PW|LR)\b/i;

function temperatureUnit(settings) {
    if ('celsius'    === settings.tempUnit) return 'C';
    if ('fahrenheit' === settings.tempUnit) return 'F';

    return FAHRENHEIT_REGIONS.test(regionTags()) ? 'F' : 'C';
}

function maybeRefreshWeather(settings, counts) {
    // Nur abfragen, wenn die Wettervorgabe ueberhaupt sichtbar ist.
    if (counts[WEATHER_ROW] > 0) return;
    if (Date.now() - weatherFetchedAt < WEATHER_MAX_AGE_MS) return;
    refreshWeather(settings);
}

function refreshWeather(settings) {
    var unit = temperatureUnit(settings);
    var latitude  = (cache.latitude  === null) ? FALLBACK_LATITUDE
                                               : cache.latitude  / COORDINATE_SCALE;
    var longitude = (cache.longitude === null) ? FALLBACK_LONGITUDE
                                               : cache.longitude / COORDINATE_SCALE;

    var url = WEATHER_URL
            + '?latitude='  + latitude.toFixed(4)
            + '&longitude=' + longitude.toFixed(4)
            + '&current=temperature_2m,weather_code'
            + '&temperature_unit=' + ('F' === unit ? 'fahrenheit' : 'celsius');

    var request = new XMLHttpRequest();
    request.open('GET', url, true);
    request.timeout = REQUEST_TIMEOUT_MS;

    request.onload = function() {
        if (request.status !== 200) {
            console.log('weather request failed: HTTP ' + request.status);
            return;
        }
        try {
            var current = (JSON.parse(request.responseText) || {}).current;
            if (!current || current.temperature_2m === undefined) return;

            cache.weather     = WEATHER_TEXT[current.weather_code] || '';
            cache.temperature = String(Math.round(current.temperature_2m));
            cache.tempunit    = '\u00B0' + unit;
            weatherFetchedAt  = Date.now();
            saveCache();
            publish(1);
        } catch (e) {
            console.log('weather not readable: ' + e);
        }
    };
    request.onerror   = function() { console.log('weather: network error'); };
    request.ontimeout = function() { console.log('weather: timeout'); };
    request.send();
}

// -------------------------------------------------------------------
// Standort
// -------------------------------------------------------------------
function refreshLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        function(position) {
            cache.latitude  = Math.round(position.coords.latitude  * COORDINATE_SCALE);
            cache.longitude = Math.round(position.coords.longitude * COORDINATE_SCALE);
            saveCache();
            publish(1);
            // Mit dem neuen Standort ist das zwischengespeicherte Wetter
            // moeglicherweise vom falschen Ort.
            weatherFetchedAt = 0;
            refresh();
        },
        function(error) {
            console.log('location not available: ' + error.message);
        },
        { timeout: REQUEST_TIMEOUT_MS, maximumAge: LOCATION_MAX_AGE_MS }
    );
}

// -------------------------------------------------------------------
// An die Uhr senden
// -------------------------------------------------------------------
// Der aktuelle Fehlerzustand gehoert zum Gesamtbild und wird bei jedem Senden
// mitgeschickt -- sonst bliebe auf der Uhr eine alte Meldung stehen, wenn
// zwischendurch nur der Standort erneuert wurde.
var currentError = '';

// Ein Sendeversuch scheitert regelmaessig, solange das Zifferblatt noch
// startet. Ein einzelner spaeter Versuch reicht, um das aufzufangen.
var RETRY_DELAY_MS = 3 * 1000;

// Die Schluessel muessen zu pebble.messageKeys in package.json und zu
// MESSAGE_KEYS in src/embeddedjs/main.js passen.
function publish(retriesLeft) {
    var dictionary = {
        error:       currentError,
        rowmode:     cache.rowmode,
        weather:     cache.weather,
        temperature: cache.temperature,
        tempunit:    cache.tempunit,
        timeformat:  cache.timeformat,
        dateformat:  cache.dateformat
    };

    ALL_SLOTS.forEach(function(suffix) {
        dictionary['value' + suffix] = cache['value' + suffix];
        dictionary['unit'  + suffix] = cache['unit'  + suffix];
    });

    if (cache.latitude !== null && cache.longitude !== null) {
        dictionary.latitude  = cache.latitude;
        dictionary.longitude = cache.longitude;
    }

    Pebble.sendAppMessage(dictionary, function() {}, function(error) {
        console.log('sending failed: ' + JSON.stringify(error));
        if (retriesLeft > 0) {
            setTimeout(function() { publish(retriesLeft - 1); }, RETRY_DELAY_MS);
        }
    });
}

function publishWithError(errorText) {
    currentError = errorText;
    publish(1);
}

// -------------------------------------------------------------------
// Ereignisse
// -------------------------------------------------------------------
Pebble.addEventListener('ready', function() {
    // Erst der zwischengespeicherte Stand, damit das Zifferblatt nicht
    // sekundenlang leer bleibt, dann die frischen Werte.
    publish(1);
    refreshLocation();
    refresh();
    setInterval(refresh, REFRESH_INTERVAL_MS);
});

Pebble.addEventListener('showConfiguration', function() {
    // Mit autoHandleEvents aus fuellt Clay clay.meta sonst nie; die Seite
    // braucht die Angaben, um sich auf die aktive Uhr einzustellen.
    clay.meta = {
        activeWatchInfo: Pebble.getActiveWatchInfo ? Pebble.getActiveWatchInfo() : null,
        accountToken: Pebble.getAccountToken(),
        watchToken: Pebble.getWatchToken(),
        userData: {}
    };
    Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function(event) {
    if (!event || !event.response) return;   // abgebrochen

    try {
        // convert=false: speichert die Eingaben in localStorage, ohne sie in
        // ein AppMessage-Format zu uebersetzen -- gesendet wird hier nichts.
        clay.getSettings(event.response, false);
    } catch (e) {
        console.log('configuration not readable: ' + e.message);
        return;
    }

    // Die Temperatureinheit kann sich geaendert haben, und eine Zeile, die
    // eben noch einen Sensor hatte, faellt jetzt vielleicht auf die
    // Wettervorgabe zurueck.
    weatherFetchedAt = 0;
    refresh();
});
