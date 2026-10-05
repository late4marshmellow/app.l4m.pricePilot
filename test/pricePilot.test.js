'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function loadWithHomeyStub(request, parent, isMain) {
  if (request === 'homey') return { App: class App {} };
  return originalLoad.call(this, request, parent, isMain);
};
const PricePilotApp = require('../app');
Module._load = originalLoad;

function createApp({ profiles, devices = {}, runtime = {} } = {}) {
  const values = new Map([
    ['boilerProfiles', profiles],
    ['boilerRuntime', runtime],
  ]);
  const app = Object.create(PricePilotApp.prototype);
  app.homey = {
    settings: {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
    },
  };
  app._getAllDevices = async () => devices;
  app.log = () => {};
  app.error = () => {};
  return app;
}

function savedProfile(overrides = {}) {
  return {
    id: 'boiler_main',
    name: 'Main boiler',
    tempDeviceId: 'sensor',
    tempCapabilityId: 'measure_temperature',
    minTemp: 45,
    targetTemp: 70,
    powerW: 3000,
    tankLiters: 200,
    maxHoursSinceGoal: 24,
    ...overrides,
  };
}

test('default, saved, edited, and migrated profiles preserve absent low targets', () => {
  const defaults = createApp()._getProfiles();
  assert.equal(defaults[0].lowTargetTemp, null);

  const saved = createApp({ profiles: [savedProfile({ lowTargetTemp: null })] })._getProfiles();
  assert.equal(saved[0].lowTargetTemp, null);

  const edited = createApp({ profiles: [savedProfile({ lowTargetTemp: 55 })] })._getProfiles();
  assert.equal(edited[0].lowTargetTemp, 55);

  const migrated = createApp({ profiles: [savedProfile()] })._getProfiles();
  assert.equal(migrated[0].lowTargetTemp, null);

  for (const value of ['', '   ', 'not-a-number', 45, 70]) {
    const profile = createApp({ profiles: [savedProfile({ lowTargetTemp: value })] })._getProfiles();
    assert.equal(profile[0].lowTargetTemp, null);
  }
});

test('profile below its minimum plans a nonzero run toward the full target without a low target', async () => {
  const app = createApp();
  const profile = savedProfile({ lowTargetTemp: null });
  app._readCurrentTempFromProfile = async () => 40;
  app._computeHoursSinceGoal = () => 0;
  app._readPlan = () => ({ state: 'idle' });
  app._setPlan = (id, state, start, end) => {
    app.plan = { id, state, start, end };
  };

  const shouldHeat = await app._planHeating(profile, [{ price: 1, durationMinutes: 15 }]);
  const runtime = app._getRuntime(profile.id);
  assert.equal(shouldHeat, true);
  assert.ok(new Date(runtime.planWindowEnd) > new Date(runtime.planWindowStart));
  assert.equal(runtime.lowTargetUsed, false);
  assert.equal(runtime.lowTargetTemp, null);
});

for (const [label, capability, stale] of [
  ['null', { value: null }, false],
  ['blank', { value: '' }, false],
  ['nonnumeric', { value: 'warm' }, false],
  ['implausible', { value: 120 }, false],
  ['stale', { value: 50, lastUpdated: new Date(Date.now() - 31 * 60 * 1000).toISOString() }, true],
]) {
  test(`unavailable ${label} temperature is rejected and cleared`, async () => {
    const app = createApp({
      devices: { sensor: { name: 'Sensor', capabilitiesObj: { measure_temperature: capability } } },
      runtime: { boiler_main: { currentTemp: 42, sensorRawTemp: 42 } },
    });
    await assert.rejects(app._readCurrentTempFromProfile(savedProfile()), stale ? /stale/ : undefined);
    const runtime = app._getRuntime('boiler_main');
    assert.equal(runtime.currentTemp, null);
    assert.equal(runtime.sensorRawTemp, null);
    assert.equal(runtime.temperatureMeasurementAvailable, false);
  });
}

for (const [label, capability, stale] of [
  ['null', { value: null }, false],
  ['blank', { value: '' }, false],
  ['nonnumeric', { value: 'unavailable' }, false],
  ['negative', { value: -1 }, false],
  ['implausible', { value: 100001 }, false],
  ['stale', { value: 100, lastChanged: new Date(Date.now() - 6 * 60 * 1000).toISOString() }, true],
]) {
  test(`unavailable ${label} power is rejected and cleared`, async () => {
    const app = createApp({
      devices: { meter: { name: 'Meter', capabilitiesObj: { measure_power: capability } } },
      runtime: { boiler_main: { currentPowerW: 900 } },
    });
    const profile = savedProfile({ powerDeviceId: 'meter', powerCapabilityId: 'measure_power' });
    await assert.rejects(app._readCurrentPowerFromProfile(profile), stale ? /stale/ : undefined);
    const runtime = app._getRuntime('boiler_main');
    assert.equal(runtime.currentPowerW, null);
    assert.equal(runtime.powerMeasurementAvailable, false);
  });
}

test('unavailable power never marks a goal reached or changes lastReachedAt', async () => {
  const priorLastReachedAt = '2026-10-01T12:00:00.000Z';
  const app = createApp({
    devices: { meter: { name: 'Meter', capabilitiesObj: { measure_power: { value: null } } } },
    runtime: {
      boiler_main: {
        controlAppliedOn: true,
        controlLastAppliedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        lastReachedAt: priorLastReachedAt,
        currentPowerW: 900,
      },
    },
  });
  const profile = savedProfile({ powerDeviceId: 'meter', powerCapabilityId: 'measure_power' });

  await assert.rejects(app._maybeMarkGoalReachedFromPower(profile, true, 'test'), /unavailable/);
  const runtime = app._getRuntime('boiler_main');
  assert.equal(runtime.lastReachedAt, priorLastReachedAt);
  assert.equal(runtime.currentPowerW, null);
  assert.equal(runtime.powerMeasurementAvailable, false);
});

test('plausible measured values are accepted and zero power remains valid', async () => {
  const app = createApp({
    devices: {
      sensor: { name: 'Sensor', capabilitiesObj: { measure_temperature: { value: 50 } } },
      meter: { name: 'Meter', capabilitiesObj: { measure_power: { value: 0 } } },
    },
  });
  const profile = savedProfile({ powerDeviceId: 'meter', powerCapabilityId: 'measure_power' });
  assert.equal(await app._readCurrentTempFromProfile(profile), 50);
  assert.equal(await app._readCurrentPowerFromProfile(profile), 0);
  assert.equal(app._getRuntime('boiler_main').temperatureMeasurementAvailable, true);
  assert.equal(app._getRuntime('boiler_main').powerMeasurementAvailable, true);
});
