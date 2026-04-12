# PricePilot

A Homey app that plans hot water boiler heating to run during the cheapest electricity price slots, while respecting a safety deadline to prevent the water from going stale.

## How it works

The app reads two values from your devices in real time:
1. **Current hot water temperature** — from a Shelly or similar sensor
2. **Hours since the boiler last reached its goal** — from a custom sensor capability

Given a list of upcoming electricity price slots (e.g. from the Tibber or Nordpool app), it finds the cheapest window long enough to heat the water, subject to a 24-hour safety limit. The plan is stored internally in the app's settings so it persists across flow runs.

## Flow cards

### Actions
- **Plan heating** *(input: price_slots JSON → token: should_heat)*
  Pass a JSON array of price slots. Finds the optimal window and returns `true` if it's time to heat right now.

### Conditions
- **Heating is scheduled now**
  Returns `true` if the current time is within the stored heating window. Use this to gate your boiler on/off flow.

## Price slot format

Each slot must have at minimum:
```json
{
  "startsAt": "2026-04-07T10:00:00.000Z",
  "endsAt":   "2026-04-07T10:15:00.000Z",
  "price":    0.123
}
```
`durationMinutes` is optional (defaults to 15).

## Price source mode

In app settings, choose one of these:

- `Nordpool (auto planning in app)`: the app fetches Nordpool prices automatically.
- `Custom flow JSON import`: Nordpool auto planning is disabled so your own flow/app can provide prices using the **Plan heating with custom prices** flow card.

## Configuration

Edit the constants at the top of `app.js` before deploying:

```js
const HEATING = {
  targetTemp: 70,        // target °C
  heatingRate: 6.5,      // °C per hour
  maxHoursSinceGoal: 24  // safety window in hours
};

const DEVICE_VALUE_CONFIGS = {
  currentHotwaterTemp: {
    searchDeviceFragmentsString: 'shelly;hotwater', // ; = AND
    selectedCapabilityFragment: 'temperature.1'
  },
  hoursSinceGoal: {
    searchDeviceFragmentsString: 'master;switch',
    selectedCapabilityFragment: 'devicecapabilities_number-custom_56.number13'
  }
};
```

## Suggested flow setup

**Flow A — Plan (runs every 15 min):**
> Trigger: Every 15 minutes → Action: **Plan heating** (with your custom price_slots JSON source)

**Flow B — Heat on/off:**
> Trigger: Every 5 minutes → Condition: **Heating is scheduled now** → Then: turn boiler ON / Else: turn boiler OFF
