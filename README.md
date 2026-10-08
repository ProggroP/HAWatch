# HA Watch

*Your Home Assistant sensors next to the time.*

A Pebble watchface (v1.2.0) built with Alloy (Moddable JavaScript). Date,
time and the watch battery are fixed; three lines can each show up to two
Home Assistant sensors. A line without sensors falls back to its default:

| Line | Default |
|---|---|
| Above the time | Sunrise and sunset |
| First line below | Current weather, e.g. "Clear, 14 °C" (from [Open-Meteo](https://open-meteo.com)) |
| Second line below | Steps and distance from Pebble Health |

## Settings

- Home Assistant URL and a long-lived access token
- For each of the three lines: left and right entity ID with unit
- Time format: follow the watch, 24 hours or 12 hours
- Date format
- Temperature unit: automatic, Celsius or Fahrenheit

The URL and token are entered on the settings page and stored on the phone;
nothing is built into the app.

## How it works

- Phone (`src/pkjs/index.js`): Home Assistant sensors, location, weather
- Watch (`src/c/health.c`, `src/c/clockstyle.c` via the FFI bridge): steps,
  distance, 12/24 hour setting
- Watch (`embedded:sensor/Battery`): battery level

## Platforms

- Pebble Time 2 (`emery`)
- Pebble Round 2 (`gabbro`)

## Building

With the [Pebble SDK](https://developer.repebble.com/sdk/) (4.17):

```bash
pebble build
pebble install --emulator emery
```

The repository can also be imported into CloudPebble as is.

## Credits

- Font: Roboto by Christian Robertson, Apache License 2.0

## License

MIT License, see [LICENSE](LICENSE). The bundled fonts are not covered by it and
remain under their own licenses.
