# PricePilot

PricePilot is a Homey app for hot water boiler control. It builds heating plans from electricity prices, keeps separate settings per boiler profile, and can either drive your heater directly or expose flow cards you can use in your own automations.

## What it does

PricePilot can:

- Manage multiple boiler profiles from one app.
- Plan heating against the cheapest available price periods.
- Respect a minimum temperature safety floor.
- Use Nordpool automatically or accept imported JSON price data from flows.
- Track live temperature with an optional correction offset.
- Use an optional power monitor to detect when the boiler has effectively reached its goal.
- Trigger ON/OFF flow cards when the heating state changes.

## Planning model

For price-based control, PricePilot continuously estimates how long the tank needs to heat from the current temperature to the target temperature.

It then:

- Chooses the cheapest valid future window before the safety deadline.
- Starts heating immediately if the temperature is already at or below the configured minimum.
- Re-evaluates plans regularly.
- Never cuts a running heating window short.
- Can extend an active window if recent hot water use means continuing now is cheaper or safer than waiting for a later window.

## Price sources

In app settings, choose one of these modes:

- `Nordpool (auto planning in app)`
  PricePilot fetches Nordpool prices itself and replans automatically.
- `Custom flow JSON import (no Nordpool auto)`
  Your own Homey flow or external logic provides price data through the action card `Plan heating with custom prices`.

The settings page includes a `Price Data` tab that shows the latest stored price snapshot, whether it came from Nordpool auto fetch or custom JSON import.

## Boiler profiles

Each profile has its own independent configuration and plan.

For each profile you can configure:

- Profile name
- Temperature sensor device and capability
- Temperature correction in °C
- Optional power monitor device and capability
- Optional direct control device and capability
- Minimum temperature
- Target temperature
- Boiler power in watts
- Tank volume in liters
- Maximum hours since goal
- Control mode

Available control modes:

- `Smart price planning`
  Uses price slots and the planner.
- `Fixed on/off time window`
  Runs inside a daily time window, with optional minimum-temperature override.

## Temperature correction

Use `Temperature correction (C)` when your sensor is consistently offset from the real water temperature.

Examples:

- If the sensor reads `67C` but the actual water is `70C`, set correction to `+3`.
- If the sensor reads `72C` but the actual water is `70C`, set correction to `-2`.

## Power monitor support

You can optionally assign a power monitor capability that reports live watts.

If PricePilot still expects the heater to be ON, but the live power falls to `0W`, the app treats that as the boiler having reached its goal and updates the runtime state accordingly. This helps when the boiler thermostat stops heating before the temperature sensor fully catches up.

## Direct control vs flows

PricePilot can work in two ways:

- `Direct control`
  If you assign a control device and capability, the app can write the ON/OFF state directly.
- `Flow-driven control`
  If you prefer flows, use the built-in trigger and condition cards to switch the heater yourself.

## Flow cards

### Action cards

- `Plan heating with custom prices`
  Input: `profile_id`, `price_slots` JSON
  Output token: `should_heat`

Use this when prices come from another app, script, API, or Homey flow instead of Nordpool auto fetch.

### Condition cards

- `Heating is scheduled now`
  Returns `true` when the selected profile should currently be heating.

### Trigger cards

- `Heating should turn ON for [[profile_id]]`
- `Heating should turn OFF for [[profile_id]]`

These trigger when PricePilot changes its decision for a profile.

## Price slot JSON format

Each imported slot must contain at least:

```json
{
  "startsAt": "2026-04-07T10:00:00.000Z",
  "endsAt": "2026-04-07T10:15:00.000Z",
  "price": 0.123
}
```

Optional field:

```json
{
  "durationMinutes": 15
}
```

Notes:

- `startsAt` and `endsAt` must be ISO date-time strings.
- `price` must be numeric.
- `durationMinutes` defaults to `15` if omitted.
- The `Price Data` tab shows the raw imported JSON timestamps unchanged, while the visual summary is shown in local browser time.

## Suggested setup

### Option A: Nordpool automatic planning

1. Set `Price source` to `Nordpool (auto planning in app)`.
2. Choose area and currency in app settings.
3. Create one or more boiler profiles.
4. Either assign a direct control device or build flows from PricePilot cards.

### Option B: Custom JSON price import

1. Set `Price source` to `Custom flow JSON import (no Nordpool auto)`.
2. Create one or more boiler profiles.
3. Build a flow that regularly calls `Plan heating with custom prices`.
4. Use the returned `should_heat` token, the condition card, or the ON/OFF trigger cards to control your heater.

## Example flow ideas

### Flow A: Import and plan

Run every 15 minutes and call `Plan heating with custom prices` with your JSON payload.

### Flow B: Heater control

Use either:

- The `Heating is scheduled now` condition on a recurring flow, or
- The `Heating should turn ON/OFF` trigger cards for event-driven control.

## Notes

- All profile settings are configured in the app settings page. There is no longer any constant-based setup in `app.js`.
- If you use custom JSON import mode, automatic Nordpool replanning is disabled until your flow sends a new price payload.
- The `Price Data` tab is intended as a read-only diagnostic view of the latest stored prices.
