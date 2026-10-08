// HA Watch -- Watchface mit drei frei konfigurierbaren Zeilen.
//
// Fest sind nur Datum, Uhrzeit und Ladestand. Die Zeile ueber der Uhrzeit und
// die beiden Zeilen darunter nehmen je bis zu zwei Home-Assistant-Sensoren auf;
// ist fuer eine Zeile keiner eingetragen, zeigt sie ihre Vorgabe:
//
//   Zeile ueber der Uhrzeit   -> Sonnenaufgang | Sonnenuntergang
//   erste Zeile darunter      -> aktuelles Wetter, z. B. "Clear, 14 °C"
//   zweite Zeile darunter     -> Schritte | Distanz
//
// Das Zeitformat richtet sich standardmaessig nach der Uhr selbst
// (clock_is_24h_style() ueber die FFI-Bruecke) und laesst sich in der
// Konfigseite fest auf 24 oder 12 Stunden stellen. Das Datumsformat kommt
// ebenfalls von dort.
//
// Datenquellen:
//   Telefon (src/pkjs/index.js) -> HA-Sensoren, Standort, Wetter
//   Uhr (src/c/health.c, src/c/clockstyle.c ueber FFI) -> Schritte, Distanz,
//     Zeitformat
//   Uhr (embedded:sensor/Battery) -> Ladestand der Uhr
//
// Gezeichnet wird ausschliesslich in draw(); alles andere setzt nur Zustand
// und ruft draw() auf.

import Poco from "commodetto/Poco";
import Message from "pebble/message";
import Battery from "embedded:sensor/Battery";
import FFI from "ffi";
import parseBMF from "commodetto/parseBMF";
import parseRLE from "commodetto/parseRLE";
import Resource from "Resource";

const render = new Poco(screen);

// -------------------------------------------------------------------
// Display
// -------------------------------------------------------------------
const SCREEN_WIDTH  = render.width;
const SCREEN_HEIGHT = render.height;
const CENTER_X      = SCREEN_WIDTH  >> 1;
const CENTER_Y      = SCREEN_HEIGHT >> 1;

// Gabbro ist 260x260 und rund, Emery 200x228 und eckig. Auf dem runden
// Display steht in Zeilen nahe dem oberen und unteren Rand deutlich weniger
// Breite zur Verfuegung -- siehe usableHalfWidth().
const IS_ROUND      = SCREEN_WIDTH === SCREEN_HEIGHT;
const SCREEN_RADIUS = CENTER_X;

// -------------------------------------------------------------------
// Farben
// -------------------------------------------------------------------
const COLOR_BACKGROUND = render.makeColor(255, 255, 255);
const COLOR_TEXT       = render.makeColor(  0,   0,   0);
const COLOR_UNIT       = render.makeColor(120, 120, 120);  // Einheiten, Hinweise
const COLOR_RULE       = render.makeColor(170, 170, 170);  // Trennlinien

// -------------------------------------------------------------------
// Schrift
// -------------------------------------------------------------------
// Die Groessen stehen in src/embeddedjs/manifest.json und werden beim Bauen
// aus den TTFs in assets/ gerastert -- ohne "monochrome", damit die Kanten
// geglaettet sind.
const FONT_TIME_SIZE  = IS_ROUND ? 60 : 60;
const FONT_INFO_SIZE  = IS_ROUND ? 24 : 24;
const FONT_SMALL_SIZE = IS_ROUND ? 20 : 20;   // nur fuer am/pm

function loadFont(name, size) {
    const font = parseBMF(new Resource(`${name}-${size}.fnt`));
    font.bitmap = parseRLE(new Resource(`${name}-${size}-alpha.bm4`));
    return font;
}

const fontTime  = loadFont("Roboto-Bold",    FONT_TIME_SIZE);
const fontInfo  = loadFont("Roboto-Regular", FONT_INFO_SIZE);
const fontSmall = loadFont("Roboto-Regular", FONT_SMALL_SIZE);

const TIME_LINE_HEIGHT  = fontTime.height;
const INFO_LINE_HEIGHT  = fontInfo.height;
const SMALL_LINE_HEIGHT = fontSmall.height;

// -------------------------------------------------------------------
// Icons
// -------------------------------------------------------------------
// Die IDs sind die Reihenfolge von pebble.resources.media in package.json,
// beginnend bei 1.
const RESOURCE_ID_SUNRISE = 1;
const RESOURCE_ID_SUNSET  = 2;
const RESOURCE_ID_STEPS   = 3;
const ICON_SIZE           = 25;   // alle drei PNGs sind 25x25

const iconSunrise = new Poco.PebbleBitmap(RESOURCE_ID_SUNRISE);
const iconSunset  = new Poco.PebbleBitmap(RESOURCE_ID_SUNSET);
const iconSteps   = new Poco.PebbleBitmap(RESOURCE_ID_STEPS);

// -------------------------------------------------------------------
// Layout
// -------------------------------------------------------------------
const VERTICAL_MARGIN = IS_ROUND ? 24 : 20;  // Luft ueber der ersten Zeile
const MIN_ROW_GAP     = 2;
const RULE_INSET      = 6;   // Trennlinien enden so weit vor dem Displayrand
const COLUMN_PADDING  = 6;   // Luft links und rechts der senkrechten Mittellinie
const ICON_GAP        = 4;   // Abstand zwischen Icon und Text
const UNIT_GAP        = 4;   // Abstand zwischen Zahl und Einheit
const TIME_SUFFIX_GAP = 6;   // Abstand zwischen am/pm und der ersten Ziffer

// Fuer die Breitenpruefung des Datums: Grossbuchstaben beginnen erst ein Stueck
// unter der Zeilenoberkante, und genau dort ist die Zeile auf dem runden
// Display am schmalsten. Wer mit der ganzen Zeilenhoehe rechnet, verschenkt
// rund 15 Pixel -- zu wenig fuer "Wed, 30 May".
const TEXT_BAND_INSET  = 5;
const TEXT_BAND_MARGIN = 3;

// Roboto setzt die Grundlinie bei rund 80 Prozent der Zeilenhoehe. Damit steht
// das kleine am/pm auf derselben Linie wie die Unterkante der Ziffern -- also
// links unten vor der Uhrzeit, statt auf halber Hoehe zu schweben.
const BASELINE_RATIO       = 0.8;
const TIME_SUFFIX_Y_OFFSET = Math.round(BASELINE_RATIO * (TIME_LINE_HEIGHT - SMALL_LINE_HEIGHT));

// Zu lange Werte werden gekuerzt; "…" liegt ausserhalb von Latin-1 und ist in
// den gerasterten Schriften nicht enthalten, deshalb ein einfacher Punkt.
const TRUNCATION_MARK = ".";

// Fuenf Infozeilen (Datum, obere Zeile, mittlere Zeile, untere Zeile, Akku) und
// dazwischen, an dritter Stelle, die Uhrzeit. Der Abstand ergibt sich aus dem
// Platz, der nach den echten Zeilenhoehen der Schriften uebrig bleibt -- so
// bleibt das Layout richtig, auch wenn eine andere Schriftgroesse gewaehlt wird.
const INFO_ROW_COUNT = 5;
const ROW_GAP = Math.max(
    MIN_ROW_GAP,
    Math.floor((SCREEN_HEIGHT - 2 * VERTICAL_MARGIN
                - TIME_LINE_HEIGHT - INFO_ROW_COUNT * INFO_LINE_HEIGHT) / 5));

const ROW_DATE_Y    = Math.floor((SCREEN_HEIGHT
                         - (TIME_LINE_HEIGHT + INFO_ROW_COUNT * INFO_LINE_HEIGHT + 5 * ROW_GAP)) / 2);
const ROW_TOP_Y     = ROW_DATE_Y + INFO_LINE_HEIGHT + ROW_GAP;
const ROW_TIME_Y    = ROW_TOP_Y  + INFO_LINE_HEIGHT + ROW_GAP;
const ROW_MIDDLE_Y  = ROW_TIME_Y + TIME_LINE_HEIGHT + ROW_GAP;
const ROW_BOTTOM_Y  = ROW_MIDDLE_Y + INFO_LINE_HEIGHT + ROW_GAP;
const ROW_BATTERY_Y = ROW_BOTTOM_Y + INFO_LINE_HEIGHT + ROW_GAP;

// -------------------------------------------------------------------
// Konfigurierbare Zeilen
// -------------------------------------------------------------------
// Die Slotnummern sind zugleich die Nummern in den AppMessage-Schluesseln
// value1..value6. Die mittlere Zeile behaelt bewusst die Slots 1 und 2: das
// waren in Version 1.1 die einzigen beiden Sensoren, und sie standen an genau
// dieser Stelle. So sieht ein Zifferblatt nach dem Update unveraendert aus,
// ohne dass jemand etwas neu eintragen muss.
const ROW_TOP    = 0;
const ROW_MIDDLE = 1;
const ROW_BOTTOM = 2;
const ROW_SLOTS  = [[3, 4], [1, 2], [5, 6]];
const ROW_COUNT  = ROW_SLOTS.length;

// -------------------------------------------------------------------
// Zustand
// -------------------------------------------------------------------
// Vom Telefon: bis zu sechs Home-Assistant-Werte, jeweils als fertig
// formatierte Zeichenkette samt Einheit. Index 0 gehoert zu Slot 1.
const SLOT_COUNT = 6;
const slotValue  = ["", "", "", "", "", ""];
const slotUnit   = ["", "", "", "", "", ""];

// Wieviele Slots je Zeile tatsaechlich belegt sind: 0 heisst "Vorgabe zeigen",
// 1 heisst "ein Wert ueber die volle Breite, ohne Trennstrich".
const rowConfigured = [0, 0, 0];

let sensorError = undefined;   // z. B. "HA not reachable"

// Zeitformat. 0 heisst "wie die Uhr eingestellt ist", 24 und 12 erzwingen das
// jeweilige Format; die Vorgabe kommt aus der Konfigseite ueber das Telefon.
const TIME_FORMAT_WATCH = 0;
const TIME_FORMAT_24    = 24;
const TIME_FORMAT_12    = 12;
let timeFormat   = TIME_FORMAT_WATCH;
let watchUses24h = true;

// Wetter als Vorgabe der mittleren Zeile; kommt fertig formatiert vom Telefon.
let weatherText        = "";
let weatherTemperature = "";
let weatherUnit        = "";

// Von der Uhr. -1 heisst "die Uhr hat noch keine Gesundheitsdaten" und ist
// etwas anderes als 0 Schritte -- siehe src/c/health.c.
const HEALTH_UNAVAILABLE = -1;
let batteryPercent      = 0;
let stepsToday          = HEALTH_UNAVAILABLE;
let distanceTodayMeters = HEALTH_UNAVAILABLE;

// Standort fuer Sonnenauf- und -untergang. Bis das Telefon die erste Position
// schickt, gilt der Mittelpunkt Deutschlands -- besser eine Zeitangabe, die um
// Minuten danebenliegt, als "--:--".
const FALLBACK_LATITUDE  = 51.16;
const FALLBACK_LONGITUDE = 10.45;
let latitude  = FALLBACK_LATITUDE;
let longitude = FALLBACK_LONGITUDE;

const DAY_NAMES_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_NAMES       = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES     = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Datumsformat. Die Zahlen sind die Werte, die das Telefon schickt; "auto"
// loest es dort schon anhand der Region auf, damit die Uhr keine Gebietsschemas
// kennen muss.
const DATE_CLASSIC     = 0;   // Tu, 25. Aug   (Darstellung bis Version 1.2)
const DATE_DAY_MONTH   = 1;   // Tue, 25 Aug
const DATE_MONTH_DAY   = 2;   // Tue, Aug 25
const DATE_NUMERIC_DAY = 3;   // Tue, 25.08.
const DATE_NUMERIC_MON = 4;   // Tue, 08/25
const DATE_ISO         = 5;   // 2026-08-25
let dateFormat = DATE_DAY_MONTH;

// -------------------------------------------------------------------
// Gesundheitsdaten der Uhr
// -------------------------------------------------------------------
// health_steps_today() und health_distance_today() stehen in src/c/health.c,
// clock_is_24h() in src/c/clockstyle.c; alle drei kommen ueber dieselbe
// FFI-Bruecke herein (siehe "ffi" in manifest.json).
let native = undefined;
try {
    const bridge = new FFI();
    if (bridge && "function" === typeof bridge.health_steps_today)
        native = bridge;
    else
        trace("FFI ohne Health-Funktionen -- fxBuildFFI in mdbl.c gesetzt?\n");
} catch (e) {
    trace(`FFI nicht verfuegbar: ${e}\n`);
}

// Wird bei jedem Minutenwechsel gerufen: Schrittzahl und Distanz aendern sich
// staendig, und das Zeitformat kann der Traeger jederzeit umstellen.
function readWatchState() {
    if (!native) return;
    try {
        stepsToday          = native.health_steps_today();
        distanceTodayMeters = native.health_distance_today();
    } catch (e) {
        trace(`Health-Abfrage fehlgeschlagen: ${e}\n`);
        native = undefined;
        return;
    }
    // Aeltere Builds ohne clock_is_24h() sollen nicht abstuerzen, sondern beim
    // 24-Stunden-Format bleiben.
    if ("function" !== typeof native.clock_is_24h) return;
    try {
        watchUses24h = 0 !== native.clock_is_24h();
    } catch (e) {
        trace(`Zeitformat nicht lesbar: ${e}\n`);
    }
}

// -------------------------------------------------------------------
// Hilfsfunktionen
// -------------------------------------------------------------------
function pad2(n) { return (n < 10 ? "0" : "") + n; }

function uses24h() {
    if (TIME_FORMAT_24 === timeFormat) return true;
    if (TIME_FORMAT_12 === timeFormat) return false;
    return watchUses24h;
}

// Liefert die Ziffern und -- nur im 12-Stunden-Format -- das passende am/pm.
// Die fuehrende Null faellt dort weg, sonst waere fuer den Zusatz kein Platz.
function clockParts(hours, minutes) {
    if (uses24h())
        return { text: pad2(hours) + ":" + pad2(minutes), suffix: "" };

    const twelve = (0 === hours % 12) ? 12 : hours % 12;
    return {
        text:   twelve + ":" + pad2(minutes),
        suffix: (hours < 12) ? "am" : "pm"
    };
}

// Halbe nutzbare Breite in der Zeile von top bis bottom. Auf dem runden
// Display ist das die halbe Sehne des Kreises an der Kante, die weiter von der
// Mitte entfernt liegt -- sonst laufen Text und Trennlinien ueber den Rand.
function usableHalfWidth(top, bottom) {
    if (!IS_ROUND)
        return CENTER_X - RULE_INSET;
    const distance = Math.max(Math.abs(top - CENTER_Y), Math.abs(bottom - CENTER_Y));
    const squared  = SCREEN_RADIUS * SCREEN_RADIUS - distance * distance;
    if (squared <= 0) return 0;
    return Math.max(0, Math.floor(Math.sqrt(squared)) - RULE_INSET);
}

// Nutzbare Breite einer Infozeile, wenn sie nicht geteilt ist.
function fullRowWidth(y) {
    return usableHalfWidth(y, y + INFO_LINE_HEIGHT) << 1;
}

// Wie fullRowWidth, aber gemessen dort, wo die Buchstaben tatsaechlich stehen,
// statt an der Oberkante des Zeilenkastens. Nur fuer die oberste und die
// unterste Zeile relevant, wo der Kreisrand knapp wird.
function textBandWidth(y) {
    if (!IS_ROUND)
        return SCREEN_WIDTH - 2 * RULE_INSET;
    const top      = y + TEXT_BAND_INSET;
    const bottom   = y + INFO_LINE_HEIGHT - 1;
    const distance = Math.max(Math.abs(top - CENTER_Y), Math.abs(bottom - CENTER_Y));
    const squared  = SCREEN_RADIUS * SCREEN_RADIUS - distance * distance;
    if (squared <= 0) return 0;
    return Math.max(0, Math.floor(Math.sqrt(squared)) - TEXT_BAND_MARGIN) << 1;
}

// Das Telefon schickt fuer eine noch nie gelesene Entity eine leere Zeichenkette.
function orPlaceholder(value) {
    return value ? value : "--";
}

// Kuerzt so lange, bis der Text in maxWidth passt. Ohne maxWidth (undefined)
// bleibt der Text unveraendert -- die festen Zeilen brauchen keine Pruefung.
function fitText(text, font, maxWidth) {
    if (!(maxWidth > 0)) return text;
    if (render.getTextWidth(text, font) <= maxWidth) return text;
    let cut = text;
    while (cut.length > 0
           && render.getTextWidth(cut + TRUNCATION_MARK, font) > maxWidth)
        cut = cut.substring(0, cut.length - 1);
    return cut + TRUNCATION_MARK;
}

function drawTextCentered(text, font, color, centerX, y) {
    render.drawText(text, font, color, centerX - (render.getTextWidth(text, font) >> 1), y);
}

// Waagerechte Trennlinie mittig zwischen zwei Zeilen, auf die dort verfuegbare
// Breite gekuerzt.
function drawRule(aboveBottom, belowTop) {
    const y     = (aboveBottom + belowTop) >> 1;
    const half  = usableHalfWidth(y, y);
    if (half <= 0) return;
    render.fillRectangle(COLOR_RULE, CENTER_X - half, y, half << 1, 1);
}

// Eine Zahl mit nachgestellter Einheit, als Gruppe um centerX zentriert. Die
// Einheit steht gedaempft, damit der Wert selbst ins Auge faellt. maxWidth ist
// optional und begrenzt die ganze Gruppe.
function drawValueWithUnit(value, unit, centerX, y, maxWidth) {
    const unitWidth  = unit ? render.getTextWidth(unit, fontInfo) + UNIT_GAP : 0;
    const text       = fitText(value, fontInfo,
                               (maxWidth > 0) ? maxWidth - unitWidth : undefined);
    const valueWidth = render.getTextWidth(text, fontInfo);
    const left       = centerX - ((valueWidth + unitWidth) >> 1);
    render.drawText(text, fontInfo, COLOR_TEXT, left, y);
    if (unit)
        render.drawText(unit, fontInfo, COLOR_UNIT, left + valueWidth + UNIT_GAP, y);
}

// Icon plus Text als Gruppe um centerX zentriert. icon darf undefined sein.
function drawIconWithText(icon, text, centerX, y, maxWidth) {
    const iconWidth = icon ? ICON_SIZE + ICON_GAP : 0;
    const shown     = fitText(text, fontInfo,
                              (maxWidth > 0) ? maxWidth - iconWidth : undefined);
    const textWidth = render.getTextWidth(shown, fontInfo);
    const left      = centerX - ((iconWidth + textWidth) >> 1);
    if (icon)
        render.drawBitmap(icon, left, y + ((INFO_LINE_HEIGHT - ICON_SIZE) >> 1));
    render.drawText(shown, fontInfo, COLOR_TEXT, left + iconWidth, y);
}

// Senkrechter Strich in der Mitte einer zweispaltigen Zeile. Liefert den
// Mittelpunkt und die nutzbare Breite der linken und der rechten Spalte.
function splitRow(y) {
    const half = usableHalfWidth(y, y + INFO_LINE_HEIGHT);
    render.fillRectangle(COLOR_RULE, CENTER_X, y + 3, 1, INFO_LINE_HEIGHT - 6);
    const offset = (half + COLUMN_PADDING) >> 1;
    return {
        left:  CENTER_X - offset,
        right: CENTER_X + offset,
        width: Math.max(0, half - COLUMN_PADDING)
    };
}

// Wochentag und Monat bleiben englisch, wie schon bisher; die Formatwahl
// bestimmt nur Reihenfolge und Zeichensetzung. DATE_CLASSIC ist die Variante
// aus Version 1.2 und bleibt waehlbar.
function formatDate(now) {
    const weekday = DAY_NAMES[now.getDay()];
    const day     = now.getDate();
    const month   = now.getMonth();

    switch (dateFormat) {
        case DATE_MONTH_DAY:
            return `${weekday}, ${MONTH_NAMES[month]} ${day}`;
        case DATE_NUMERIC_DAY:
            return `${weekday}, ${pad2(day)}.${pad2(month + 1)}.`;
        case DATE_NUMERIC_MON:
            return `${weekday}, ${pad2(month + 1)}/${pad2(day)}`;
        case DATE_ISO:
            return `${now.getFullYear()}-${pad2(month + 1)}-${pad2(day)}`;
        case DATE_CLASSIC:
            return `${DAY_NAMES_SHORT[now.getDay()]}, ${pad2(day)}. ${MONTH_NAMES[month]}`;
        default:
            return `${weekday}, ${day} ${MONTH_NAMES[month]}`;
    }
}

// Die grosse Uhrzeit, als Gruppe zentriert. Im 12-Stunden-Format steht das
// kleine am/pm links davor und schliesst unten mit den Ziffern ab. Die
// Ziffernschrift ist nur mit "0123456789:" gerastert (siehe manifest.json),
// deshalb muss der Zusatz aus fontSmall kommen.
function drawTimeRow(y, hours, minutes) {
    const parts     = clockParts(hours, minutes);
    const timeWidth = render.getTextWidth(parts.text, fontTime);

    if (!parts.suffix) {
        render.drawText(parts.text, fontTime, COLOR_TEXT,
                        CENTER_X - (timeWidth >> 1), y);
        return;
    }

    const suffixWidth = render.getTextWidth(parts.suffix, fontSmall);
    const left        = CENTER_X - ((suffixWidth + TIME_SUFFIX_GAP + timeWidth) >> 1);
    render.drawText(parts.suffix, fontSmall, COLOR_UNIT,
                    left, y + TIME_SUFFIX_Y_OFFSET);
    render.drawText(parts.text, fontTime, COLOR_TEXT,
                    left + suffixWidth + TIME_SUFFIX_GAP, y);
}

// -------------------------------------------------------------------
// Sonnenauf- und -untergang
// -------------------------------------------------------------------
// Vereinfachte Sonnenstandsgleichung (Wikipedia "Sunrise equation"). Genau auf
// ein bis zwei Minuten -- fuer ein Watchface reichlich.
function sunTimes() {
    const now        = new Date();
    const julianDay  = Math.floor(now.getTime() / 86400000 + 2440587.5 + 0.5);
    const dayNumber  = julianDay - 2451545.0009;
    const meanDay    = dayNumber - longitude / 360;

    const meanAnomaly    = ((357.5291 + 0.98560028 * meanDay) % 360 + 360) % 360;
    const meanAnomalyRad = meanAnomaly * Math.PI / 180;
    const equationOfCenter = 1.9148 * Math.sin(meanAnomalyRad)
                           + 0.02   * Math.sin(2 * meanAnomalyRad)
                           + 0.0003 * Math.sin(3 * meanAnomalyRad);

    const eclipticLongitude    = ((meanAnomaly + equationOfCenter + 282.9372) % 360 + 360) % 360;
    const eclipticLongitudeRad = eclipticLongitude * Math.PI / 180;

    const solarNoon = 2451545.0009 + meanDay
                    + 0.0053 * Math.sin(meanAnomalyRad)
                    - 0.0069 * Math.sin(2 * eclipticLongitudeRad);

    const sinDeclination = Math.sin(eclipticLongitudeRad) * Math.sin(23.4397 * Math.PI / 180);
    const cosDeclination = Math.sqrt(1 - sinDeclination * sinDeclination);
    const latitudeRad    = latitude * Math.PI / 180;

    // -0.8333 Grad: Sonnenmitte unter dem Horizont bei sichtbarem Auf-/Untergang.
    const cosHourAngle = (Math.sin(-0.8333 * Math.PI / 180)
                          - Math.sin(latitudeRad) * sinDeclination)
                       / (Math.cos(latitudeRad) * cosDeclination);

    // Polartag oder Polarnacht: die Sonne geht an diesem Tag nicht auf bzw. unter.
    if (cosHourAngle < -1 || cosHourAngle > 1)
        return { rise: undefined, set: undefined };

    const hourAngle = Math.acos(cosHourAngle) * 180 / Math.PI;
    // Roh als Stunde und Minute, damit die Zeitformatierung erst beim Zeichnen
    // entscheidet -- sonst waere das 12-Stunden-Format hier eingebacken.
    const asTime = julian => {
        const d = new Date((julian - 2440587.5) * 86400000);
        return { hours: d.getHours(), minutes: d.getMinutes() };
    };
    return {
        rise: asTime(solarNoon - hourAngle / 360),
        set:  asTime(solarNoon + hourAngle / 360)
    };
}

// -------------------------------------------------------------------
// Vorgaben der drei konfigurierbaren Zeilen
// -------------------------------------------------------------------
// Die beiden Vorgabezeilen mit Uhrzeiten bzw. Schritten bekommen bewusst keine
// Breitenbegrenzung: ihre Laenge ist bekannt und passt, waehrend die
// Sehnenrechnung am unteren Displayrand vorsichtshalber zu schmal schaetzt und
// eine fuenfstellige Schrittzahl sonst gekuerzt wuerde.
// Im 12-Stunden-Format bleibt hier bewusst das am/pm weg: neben dem 25 Pixel
// breiten Icon ist in der 90 Pixel schmalen Spalte kein Platz dafuer, und das
// Icon selbst sagt bereits, ob es um Morgen oder Abend geht. Es faellt nur die
// fuehrende Null weg, aus "06:17 | 20:30" wird "6:17 | 8:30".
function sunClock(time) {
    return time ? clockParts(time.hours, time.minutes).text : "--:--";
}

function drawSunDefault(y) {
    const sun     = sunTimes();
    const columns = splitRow(y);
    drawIconWithText(iconSunrise, sunClock(sun.rise), columns.left,  y);
    drawIconWithText(iconSunset,  sunClock(sun.set),  columns.right, y);
}

// "Clear, 14 °C" -- Bezeichnung und Zahl in Textfarbe, die Einheit gedaempft.
function drawWeatherDefault(y) {
    if (!weatherTemperature) {
        drawValueWithUnit("--", "", CENTER_X, y, fullRowWidth(y));
        return;
    }
    const label = weatherText ? weatherText + ", " : "";
    drawValueWithUnit(label + weatherTemperature, weatherUnit,
                      CENTER_X, y, fullRowWidth(y));
}

function drawActivityDefault(y) {
    const columns = splitRow(y);
    drawIconWithText(iconSteps,
                     HEALTH_UNAVAILABLE === stepsToday ? "---" : String(stepsToday),
                     columns.left, y);
    const distance = (HEALTH_UNAVAILABLE === distanceTodayMeters)
                   ? "--.-"
                   : (distanceTodayMeters / 1000).toFixed(1);
    drawValueWithUnit(distance, "km", columns.right, y);
}

const ROW_DEFAULTS = [drawSunDefault, drawWeatherDefault, drawActivityDefault];

// -------------------------------------------------------------------
// Eine konfigurierbare Zeile zeichnen
// -------------------------------------------------------------------
// Ohne belegten Slot steht die Vorgabe da. Bei genau einem Slot nimmt der Wert
// die ganze Zeilenbreite ein und der Trennstrich entfaellt.
function drawConfigurableRow(rowIndex, y, showError) {
    const count = rowConfigured[rowIndex];

    if (0 === count) {
        ROW_DEFAULTS[rowIndex](y);
        return;
    }

    if (showError) {
        drawTextCentered(fitText(sensorError, fontInfo, fullRowWidth(y)),
                         fontInfo, COLOR_UNIT, CENTER_X, y);
        return;
    }

    const slots = ROW_SLOTS[rowIndex];

    if (1 === count) {
        const slot = slots[0] - 1;
        drawValueWithUnit(orPlaceholder(slotValue[slot]), slotUnit[slot],
                          CENTER_X, y, fullRowWidth(y));
        return;
    }

    const columns = splitRow(y);
    const first   = slots[0] - 1;
    const second  = slots[1] - 1;
    drawValueWithUnit(orPlaceholder(slotValue[first]),  slotUnit[first],
                      columns.left,  y, columns.width);
    drawValueWithUnit(orPlaceholder(slotValue[second]), slotUnit[second],
                      columns.right, y, columns.width);
}

// -------------------------------------------------------------------
// Zeichnen
// -------------------------------------------------------------------
function draw() {
    const now = new Date();

    // Eine Stoerungsmeldung gehoert genau einmal aufs Zifferblatt, sonst stuende
    // dreimal dasselbe da. Sie ersetzt die oberste belegte Zeile; die anderen
    // zeigen weiter ihren letzten bekannten Stand.
    let errorRow = -1;
    if (sensorError !== undefined) {
        for (let row = 0; row < ROW_COUNT; row += 1) {
            if (rowConfigured[row] > 0) { errorRow = row; break; }
        }
    }

    render.begin();
    render.fillRectangle(COLOR_BACKGROUND, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    // Trennlinien zwischen allen sechs Zeilen
    drawRule(ROW_DATE_Y   + INFO_LINE_HEIGHT, ROW_TOP_Y);
    drawRule(ROW_TOP_Y    + INFO_LINE_HEIGHT, ROW_TIME_Y);
    drawRule(ROW_TIME_Y   + TIME_LINE_HEIGHT, ROW_MIDDLE_Y);
    drawRule(ROW_MIDDLE_Y + INFO_LINE_HEIGHT, ROW_BOTTOM_Y);
    drawRule(ROW_BOTTOM_Y + INFO_LINE_HEIGHT, ROW_BATTERY_Y);

    // Zeile 1: Datum
    drawTextCentered(fitText(formatDate(now), fontInfo, textBandWidth(ROW_DATE_Y)),
                     fontInfo, COLOR_TEXT, CENTER_X, ROW_DATE_Y);

    // Zeile 2: konfigurierbar, Vorgabe Sonnenauf- und -untergang
    drawConfigurableRow(ROW_TOP, ROW_TOP_Y, ROW_TOP === errorRow);

    // Zeile 3: Uhrzeit
    drawTimeRow(ROW_TIME_Y, now.getHours(), now.getMinutes());

    // Zeile 4: konfigurierbar, Vorgabe Wetter
    drawConfigurableRow(ROW_MIDDLE, ROW_MIDDLE_Y, ROW_MIDDLE === errorRow);

    // Zeile 5: konfigurierbar, Vorgabe Schritte und Distanz
    drawConfigurableRow(ROW_BOTTOM, ROW_BOTTOM_Y, ROW_BOTTOM === errorRow);

    // Zeile 6: Ladestand der Uhr
    drawValueWithUnit(String(batteryPercent), "%", CENTER_X, ROW_BATTERY_Y);

    render.end();
}

// -------------------------------------------------------------------
// Uhrenakku
// -------------------------------------------------------------------
const battery = new Battery({
    onSample() {
        batteryPercent = battery.sample().percent;
        draw();
    }
});
batteryPercent = battery.sample().percent;

// -------------------------------------------------------------------
// AppMessage vom Telefon
// -------------------------------------------------------------------
// Die Reihenfolge muss Zeichen fuer Zeichen zu pebble.messageKeys in
// package.json passen: pebble/message bildet den Index auf 10000+n ab, und
// PebbleKit JS tut dasselbe. Ein verschobener Eintrag vertauscht stumm die
// Werte. "dummy" haelt den ersten Platz frei, und neue Schluessel kommen
// ausschliesslich hinten dazu.
const MESSAGE_KEYS = ["dummy", "value1", "unit1", "value2", "unit2",
                      "latitude", "longitude", "error",
                      "value3", "unit3", "value4", "unit4",
                      "value5", "unit5", "value6", "unit6",
                      "rowmode", "weather", "temperature", "tempunit",
                      "timeformat", "dateformat"];

// Zwei Bit je Zeile, von unten nach oben: obere, mittlere, untere Zeile.
const ROW_MODE_MASK = 3;
const ROW_MODE_BITS = 2;

function applyRowMode(mode) {
    for (let row = 0; row < ROW_COUNT; row += 1)
        rowConfigured[row] = (mode >> (row * ROW_MODE_BITS)) & ROW_MODE_MASK;
}

const message = new Message({
    input: 512,
    output: 128,
    keys: MESSAGE_KEYS,
    onReadable() {
        const received = message.read();

        // Leerer Text heisst "kein Fehler mehr"; fehlt der Schluessel ganz,
        // bleibt der bisherige Zustand stehen.
        const error = received.get("error");
        if (error !== undefined)
            sensorError = ("" === error) ? undefined : error;

        const mode = received.get("rowmode");
        if (mode !== undefined) applyRowMode(mode);

        const format = received.get("timeformat");
        if (format !== undefined) timeFormat = format;

        const dateStyle = received.get("dateformat");
        if (dateStyle !== undefined) dateFormat = dateStyle;

        for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
            const value = received.get(`value${slot}`);
            const unit  = received.get(`unit${slot}`);
            if (value !== undefined) slotValue[slot - 1] = value;
            if (unit  !== undefined) slotUnit[slot - 1]  = unit;
        }

        const condition   = received.get("weather");
        const temperature = received.get("temperature");
        const unit        = received.get("tempunit");
        if (condition   !== undefined) weatherText        = condition;
        if (temperature !== undefined) weatherTemperature = temperature;
        if (unit        !== undefined) weatherUnit        = unit;

        // Der Standort kommt als Ganzzahl mit fuenf Nachkommastellen herein,
        // weil AppMessage keine Gleitkommazahlen kennt.
        const receivedLatitude  = received.get("latitude");
        const receivedLongitude = received.get("longitude");
        if (receivedLatitude  !== undefined) latitude  = receivedLatitude  / 100000;
        if (receivedLongitude !== undefined) longitude = receivedLongitude / 100000;

        draw();
    }
});

// -------------------------------------------------------------------
// Jede Minute neu zeichnen
// -------------------------------------------------------------------
watch.addEventListener("minutechange", () => {
    readWatchState();
    draw();
});

readWatchState();
draw();
