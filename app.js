'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { fetchPriceSlots } = require('./lib/NordpoolClient');

const OSLO_TZ = 'Europe/Oslo';
const NORDPOOL_PUBLISH_HOUR_OSLO = 13;
const NORDPOOL_PUBLISH_GRACE_MINUTES = 20;
const NORDPOOL_MAX_CACHE_AGE_HOURS = 36;
const POWER_GOAL_REACHED_MAX_WATTS = 0.5;
const POWER_GOAL_REACHED_MIN_ON_MINUTES = 5;

module.exports = class PricePilotApp extends Homey.App {

  async onInit() {
    this.log('PricePilot app initialized');

    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
    this._autoPlanInProgress = false;
    this._autoPlanQueued = false;

    this.homey.settings.on('set', (key) => {
      if (key === 'boilerSensorCatalogRefreshRequest') {
        this.log('Sensor catalog refresh requested from settings UI');
        this._refreshSensorCatalog().catch((err) => {
          this.error('Failed to refresh temperature sensor catalog on-demand:', err.message);
        });
      }

      if (key === 'nordpoolDebugRefreshRequest') {
        this.log('Nordpool debug refresh requested from settings UI');
        this._fetchNordpoolForDebug().catch((err) => {
          this.error('Failed Nordpool debug fetch on-demand:', err.message);
        });
      }

      if (key === 'boilerProfiles' || key === 'areaId' || key === 'currency' || key === 'priceSource') {
        this._autoPlanAllProfiles(`settings:${key}`).catch((err) => {
          this.error('Auto planning failed after settings change:', err.message);
        });
      }
    });

    await this._refreshSensorCatalog().catch((err) => {
      this.error('Failed to build temperature sensor catalog on init:', err.message);
    });
    this.homey.setInterval(() => {
      this._refreshSensorCatalog().catch((err) => {
        this.error('Failed to refresh temperature sensor catalog:', err.message);
      });
    }, 15 * 60 * 1000);

    const planCard = this.homey.flow.getActionCard('plan_heating');
    const conditionCard = this.homey.flow.getConditionCard('heating_scheduled_now');
    const whenOnCard = this.homey.flow.getTriggerCard('heating_should_turn_on');
    const whenOffCard = this.homey.flow.getTriggerCard('heating_should_turn_off');

    this.heatingShouldTurnOnCard = whenOnCard;
    this.heatingShouldTurnOffCard = whenOffCard;

    this._registerProfileAutocomplete(planCard);
    this._registerProfileAutocomplete(conditionCard);
    this._registerProfileAutocomplete(whenOnCard);
    this._registerProfileAutocomplete(whenOffCard);

    whenOnCard.registerRunListener(async (args, state) => {
      const selected = this._extractProfileId(args.profile_id);
      const stateProfile = this._extractProfileId(state && state.profile_id);
      return selected === stateProfile;
    });

    whenOffCard.registerRunListener(async (args, state) => {
      const selected = this._extractProfileId(args.profile_id);
      const stateProfile = this._extractProfileId(state && state.profile_id);
      return selected === stateProfile;
    });

    // --- Action: Plan heating (caller supplies price slots JSON) ---
    planCard.registerRunListener(async (args) => {
      let priceSlots;
      try {
        priceSlots = typeof args.price_slots === 'string'
          ? JSON.parse(args.price_slots)
          : args.price_slots;
      } catch (err) {
        throw new Error(`price_slots is not valid JSON: ${err.message}`);
      }

      const profile = this._requireProfileFromArg(args.profile_id);
      const shouldHeat = await this._planHeating(
        profile,
        priceSlots
      );
      await this._syncHeatingStateAndTrigger(profile.id, 'manual:plan_heating');
      return { should_heat: shouldHeat };
    });

    // --- Condition: Heating is scheduled now ---
    conditionCard.registerRunListener(async (args) => {
      const profile = this._requireProfileFromArg(args.profile_id);
      return this._isHeatingNow(profile.id);
    });

    this._autoPlanAllProfiles('init').catch((err) => {
      this.error('Auto planning failed on init:', err.message);
    });

    this.homey.setInterval(() => {
      this._autoPlanAllProfiles('interval').catch((err) => {
        this.error('Auto planning failed on interval:', err.message);
      });
    }, 10 * 60 * 1000);

    this.homey.setInterval(() => {
      this._refreshHeatingStates('interval').catch((err) => {
        this.error('Heating state refresh failed:', err.message);
      });
    }, 60 * 1000);
  }

  async _autoPlanAllProfiles(source) {
    if (this._autoPlanInProgress) {
      this._autoPlanQueued = true;
      return;
    }

    this._autoPlanInProgress = true;
    try {
      const profiles = this._getProfiles();
      const priceSource = String(this.homey.settings.get('priceSource') || 'nordpool_auto').trim();
      const useNordpoolAuto = priceSource !== 'custom_flow';
      if (profiles.length === 0) {
        return;
      }
      for (const profile of profiles) {
        try {
          if (profile.controlMode === 'fixed_window') {
            await this._planHeating(profile, []);
            await this._syncHeatingStateAndTrigger(profile.id, `auto:${source}`);
            continue;
          }

          if (!useNordpoolAuto) {
            this.log(`[${profile.id}] Auto planner skipped: price source is custom_flow (use flow card "Plan heating with custom prices")`);
            continue;
          }

          const area = (this.homey.settings.get('areaId') || '').trim();
          const currency = (this.homey.settings.get('currency') || '').trim();
          if (!area || !currency) {
            this.log(`[${profile.id}] Auto planner skipped: area/currency not configured yet`);
            continue;
          }

          if (this._shouldRefreshNordpoolCache(area, currency)) {
            try {
              this._cachedAutoPriceSlots = await fetchPriceSlots(area, currency);
              this._cachedAutoPriceArea = area;
              this._cachedAutoPriceCurrency = currency;
              this._storeNordpoolFetchSnapshot(area, currency, this._cachedAutoPriceSlots);
            } catch (err) {
              this._storeNordpoolFetchError(area, currency, err);
              throw err;
            }
          }

          await this._planHeating(profile, this._cachedAutoPriceSlots);
          await this._syncHeatingStateAndTrigger(profile.id, `auto:${source}`);
        } catch (err) {
          this.error(`[${profile.id}] Auto planning failed:`, err.message);
        }
      }
    } finally {
      this._autoPlanInProgress = false;
      if (this._autoPlanQueued) {
        this._autoPlanQueued = false;
        this._autoPlanAllProfiles('queued').catch((err) => {
          this.error('Auto planning failed in queued run:', err.message);
        });
      }
    }
  }

  async _refreshHeatingStates(source) {
    const profiles = this._getProfiles();
    for (const profile of profiles) {
      await this._syncHeatingStateAndTrigger(profile.id, source || 'state-refresh');
    }
  }

  /*************************************************
   * PLANNING LOGIC
   *************************************************/

  async _planHeating(profile, priceSlots) {
    const planId = profile.id;
    const controlMode = profile.controlMode === 'fixed_window' ? 'fixed_window' : 'price';
    const now = new Date();

    if (!planId || typeof planId !== 'string') throw new Error('profile_id must be selected');

    if (controlMode === 'fixed_window') {
      const fixed = this._computeFixedWindow(profile.fixedWindowStart, profile.fixedWindowEnd, now);
      const monitorMinTemp = !!profile.fixedMinTempMonitor;
      const minTemp = Number(profile.minTemp);

      let currentTemp = null;
      let fixedMinTempTriggered = false;
      let planStart = fixed.start;
      let planEnd = fixed.end;
      let shouldHeat = fixed.isOn;

      if (monitorMinTemp) {
        if (!Number.isFinite(minTemp)) {
          throw new Error('Fixed mode minimum temperature must be numeric when monitoring is enabled');
        }
        currentTemp = await this._readCurrentTempFromProfile(profile);

        // Safety override: if below minimum temperature while fixed window is OFF,
        // force a short heating run and let the next planner pass re-evaluate.
        if (!fixed.isOn && currentTemp <= minTemp) {
          fixedMinTempTriggered = true;
          shouldHeat = true;
          planStart = now;
          planEnd = new Date(now.getTime() + 30 * 60 * 1000);
        }
      }

      this._setPlan(planId, 'planned', planStart, planEnd);
      this._patchRuntime(planId, {
        controlMode,
        fixedMinTempMonitor: monitorMinTemp,
        fixedMinTempTriggered,
        minTemp,
        currentTemp,
        fixedWindowStart: profile.fixedWindowStart,
        fixedWindowEnd: profile.fixedWindowEnd,
        planState: 'planned',
        planWindowStart: planStart.toISOString(),
        planWindowEnd: planEnd.toISOString(),
        heaterShouldBeOn: shouldHeat,
        updatedAt: now.toISOString(),
      });
      this.log(`[${planId}] Fixed window ${profile.fixedWindowStart}-${profile.fixedWindowEnd} => ${planStart.toISOString()} -> ${planEnd.toISOString()} (${shouldHeat ? 'ON' : 'OFF'})${fixedMinTempTriggered ? ` [min-temp override ${currentTemp}°C <= ${minTemp}°C]` : ''}`);
      return shouldHeat;
    }

    const targetTemp = Number(profile.targetTemp);
    const minTemp = Number(profile.minTemp);
    const heatingRate = this._computeHeatingRatePerHour(profile.powerW, profile.tankLiters);
    const maxHoursSinceGoal = Number(profile.maxHoursSinceGoal);
    const currentTemp = await this._readCurrentTempFromProfile(profile);

    if (!Array.isArray(priceSlots) || priceSlots.length === 0) throw new Error('Price slots must be a non-empty array');
    if (!Number.isFinite(currentTemp))          throw new Error('current_temp must be a number');
    if (!Number.isFinite(minTemp))              throw new Error('min_temp must be a number');
    if (!Number.isFinite(targetTemp))            throw new Error('target_temp must be a number');
    if (!Number.isFinite(heatingRate) || heatingRate <= 0)          throw new Error('heating_rate must be a positive number');
    if (!Number.isFinite(maxHoursSinceGoal) || maxHoursSinceGoal <= 0) throw new Error('max_hours must be a positive number');

    const hoursSinceGoal = this._computeHoursSinceGoal(planId, currentTemp, targetTemp, maxHoursSinceGoal);
    const hoursToHeat = this._computeHoursToHeat(currentTemp, targetTemp, heatingRate);

    if (hoursToHeat <= 0) {
      this._setPlan(planId, 'idle', null, null);
      this._patchRuntime(planId, {
        controlMode,
        planState: 'idle',
        planWindowStart: null,
        planWindowEnd: null,
        heaterShouldBeOn: false,
        updatedAt: now.toISOString(),
      });
      this.log(`[${planId}] Already at target (${currentTemp}°C ≥ ${targetTemp}°C). Plan cleared.`);
      return false;
    }

    this.log(`[${planId}] ${currentTemp}°C → ${targetTemp}°C needs ${hoursToHeat}h. Last goal ${hoursSinceGoal}h ago (limit ${maxHoursSinceGoal}h).`);

    // Hard safety floor: if below minimum temp, heat immediately.
    if (currentTemp <= minTemp) {
      const end = new Date(now.getTime() + hoursToHeat * 3600000);
      this._setPlan(planId, 'planned', now, end);
      this._patchRuntime(planId, {
        controlMode,
        planState: 'planned',
        planWindowStart: now.toISOString(),
        planWindowEnd: end.toISOString(),
        heaterShouldBeOn: true,
        updatedAt: now.toISOString(),
      });
      this.log(`[${planId}] Minimum temperature reached (${currentTemp}°C <= ${minTemp}°C). Emergency heating now.`);
      return true;
    }

    // Freeze plan if we are currently inside an active window
    const existing = this._readPlan(planId);
    if (existing.state === 'planned' && existing.start && existing.end && now >= existing.start && now < existing.end) {
      this._patchRuntime(planId, {
        controlMode,
        planState: 'planned',
        planWindowStart: existing.start.toISOString(),
        planWindowEnd: existing.end.toISOString(),
        heaterShouldBeOn: true,
        updatedAt: now.toISOString(),
      });
      this.log(`[${planId}] Inside active window — keeping plan unchanged`);
      return true;
    }

    // Emergency: at or over safety limit → heat immediately
    if (hoursSinceGoal >= maxHoursSinceGoal) {
      const end = new Date(now.getTime() + hoursToHeat * 3600000);
      this._setPlan(planId, 'planned', now, end);
      this._patchRuntime(planId, {
        controlMode,
        planState: 'planned',
        planWindowStart: now.toISOString(),
        planWindowEnd: end.toISOString(),
        heaterShouldBeOn: true,
        updatedAt: now.toISOString(),
      });
      this.log(`[${planId}] Emergency: ${now.toISOString()} → ${end.toISOString()}`);
      return true;
    }

    // Normal planning: find cheapest window that fits before the safety deadline
    const slotMin = priceSlots[0].durationMinutes || 15;
    const slotsNeeded = Math.max(1, Math.ceil((hoursToHeat * 60) / slotMin));
    const latestStart = new Date(now.getTime() + (maxHoursSinceGoal - hoursSinceGoal) * 3600000);

    const windows = [];
    for (let i = 0; i + slotsNeeded <= priceSlots.length; i++) {
      const wStart = new Date(priceSlots[i].startsAt);
      const wEnd   = new Date(priceSlots[i + slotsNeeded - 1].endsAt);
      if (wEnd <= now || wStart < now) continue;
      let cost = 0;
      for (let j = i; j < i + slotsNeeded; j++) {
        const s = priceSlots[j];
        cost += s.price * ((s.durationMinutes || 15) / 60);
      }
      windows.push({ start: wStart, end: wEnd, cost });
    }

    if (windows.length === 0) {
      this._setPlan(planId, 'idle', null, null);
      this._patchRuntime(planId, {
        controlMode,
        planState: 'idle',
        planWindowStart: null,
        planWindowEnd: null,
        heaterShouldBeOn: false,
        updatedAt: now.toISOString(),
      });
      this.log(`[${planId}] No future windows in price data — plan cleared`);
      return false;
    }

    const safeWindows = windows.filter(w => w.start <= latestStart);

    if (safeWindows.length === 0) {
      const end = new Date(now.getTime() + hoursToHeat * 3600000);
      this._setPlan(planId, 'planned', now, end);
      this._patchRuntime(planId, {
        controlMode,
        planState: 'planned',
        planWindowStart: now.toISOString(),
        planWindowEnd: end.toISOString(),
        heaterShouldBeOn: true,
        updatedAt: now.toISOString(),
      });
      this.log(`[${planId}] No safe windows left — emergency: ${now.toISOString()} → ${end.toISOString()}`);
      return true;
    }

    const best = safeWindows.reduce((a, b) =>
      b.cost < a.cost || (b.cost === a.cost && b.start < a.start) ? b : a
    );

    this._setPlan(planId, 'planned', best.start, best.end);
    this._patchRuntime(planId, {
      controlMode,
      planState: 'planned',
      planWindowStart: best.start.toISOString(),
      planWindowEnd: best.end.toISOString(),
      heaterShouldBeOn: now >= best.start && now < best.end,
      updatedAt: now.toISOString(),
    });
    this.log(`[${planId}] Best window: ${best.start.toISOString()} → ${best.end.toISOString()} (cost ${best.cost.toFixed(4)})`);

    return now >= best.start && now < best.end;
  }

  _registerProfileAutocomplete(card) {
    card.registerArgumentAutocompleteListener('profile_id', async (query) => {
      const q = (query || '').trim().toLowerCase();
      return this._getProfiles()
        .filter((p) => !q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
        .slice(0, 20)
        .map((p) => ({
          id: p.id,
          name: `${p.name} (${p.id})`,
        }));
    });
  }

  _requireProfileFromArg(profileArg) {
    const profileId = this._extractProfileId(profileArg);
    const profile = this._getProfiles().find((p) => p.id === profileId);
    if (!profile) {
      throw new Error(`Boiler profile "${profileId || '(none)'}" was not found. Create it in app settings first.`);
    }
    return profile;
  }

  _extractProfileId(profileArg) {
    if (!profileArg) return '';
    if (typeof profileArg === 'string') return profileArg;
    if (typeof profileArg === 'object' && typeof profileArg.id === 'string') return profileArg.id;
    return '';
  }

  _getProfiles() {
    const raw = this.homey.settings.get('boilerProfiles');
    if (!Array.isArray(raw) || raw.length === 0) {
      return [this._defaultProfile()];
    }
    const profiles = raw
      .map((p) => ({
        id: this._sanitizeProfileId(p.id),
        name: String(p.name || p.id || '').trim() || this._sanitizeProfileId(p.id),
        tempDeviceId: String(p.tempDeviceId || '').trim(),
        tempCapabilityId: String(p.tempCapabilityId || '').trim(),
        tempCorrection: Number.isFinite(Number(p.tempCorrection)) ? Number(p.tempCorrection) : 0,
        powerDeviceId: String(p.powerDeviceId || '').trim(),
        powerCapabilityId: String(p.powerCapabilityId || '').trim(),
        controlDeviceId: String(p.controlDeviceId || '').trim(),
        controlCapabilityId: String(p.controlCapabilityId || '').trim() || 'onoff',
        minTemp: Number(p.minTemp),
        targetTemp: Number(p.targetTemp),
        powerW: Number(p.powerW),
        tankLiters: Number(p.tankLiters),
        maxHoursSinceGoal: Number(p.maxHoursSinceGoal),
        controlMode: p.controlMode === 'fixed_window' ? 'fixed_window' : 'price',
        fixedMinTempMonitor: !!p.fixedMinTempMonitor,
        fixedWindowStart: this._isValidClockTime(p.fixedWindowStart) ? String(p.fixedWindowStart) : '22:00',
        fixedWindowEnd: this._isValidClockTime(p.fixedWindowEnd) ? String(p.fixedWindowEnd) : '06:00',
      }))
      .filter((p) => {
        if (!p.id) return false;
        if (p.controlMode === 'fixed_window') {
          const hasValidWindow = this._isValidClockTime(p.fixedWindowStart)
            && this._isValidClockTime(p.fixedWindowEnd)
            && p.fixedWindowStart !== p.fixedWindowEnd;
          if (!hasValidWindow) return false;
          if (!p.fixedMinTempMonitor) return true;
          return p.tempDeviceId
            && p.tempCapabilityId
            && Number.isFinite(p.minTemp);
        }
        return p.tempDeviceId
          && p.tempCapabilityId
          && Number.isFinite(p.minTemp)
          && Number.isFinite(p.targetTemp)
          && p.targetTemp > p.minTemp
          && Number.isFinite(p.powerW) && p.powerW > 0
          && Number.isFinite(p.tankLiters) && p.tankLiters > 0
          && Number.isFinite(p.maxHoursSinceGoal) && p.maxHoursSinceGoal > 0;
      });

      return profiles.length > 0 ? profiles : [this._defaultProfile()];
  }

  _defaultProfile() {
    return {
      id: 'boiler_main',
      name: 'Main boiler',
      tempDeviceId: '',
      tempCapabilityId: 'measure_temperature',
      tempCorrection: 0,
      powerDeviceId: '',
      powerCapabilityId: '',
      controlDeviceId: '',
      controlCapabilityId: 'onoff',
      minTemp: 45,
      targetTemp: 70,
      powerW: 3000,
      tankLiters: 200,
      maxHoursSinceGoal: 24,
      controlMode: 'price',
      fixedMinTempMonitor: false,
      fixedWindowStart: '22:00',
      fixedWindowEnd: '06:00',
    };
  }

  _sanitizeProfileId(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /*************************************************
   * STATE  (keyed by plan_id so multiple boilers
   *         do not interfere with each other)
   *************************************************/

  _readPlan(planId) {
    const k = this._sanitizeProfileId(planId);
    const state = this.homey.settings.get(`planState_${k}`) || 'idle';

    const parseDate = (key) => {
      const s = this.homey.settings.get(key);
      if (!s) return null;
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    };

    return {
      state,
      start: parseDate(`planStart_${k}`),
      end:   parseDate(`planEnd_${k}`),
    };
  }

  _setPlan(planId, state, startDate, endDate) {
    const k = this._sanitizeProfileId(planId);
    this.homey.settings.set(`planState_${k}`, state);
    this.homey.settings.set(`planStart_${k}`, startDate ? startDate.toISOString() : null);
    this.homey.settings.set(`planEnd_${k}`,   endDate   ? endDate.toISOString()   : null);
  }

  _isHeatingNow(planId) {
    const profile = this._getProfiles().find((p) => p.id === this._sanitizeProfileId(planId));
    if (profile && profile.controlMode === 'fixed_window') {
      const now = new Date();
      const runtime = this._getRuntime(planId) || {};
      const plan = this._readPlan(planId);
      const inMinTempOverride = !!runtime.fixedMinTempTriggered
        && plan.state === 'planned'
        && plan.start
        && plan.end
        && now >= plan.start
        && now < plan.end;

      const fixed = this._computeFixedWindow(profile.fixedWindowStart, profile.fixedWindowEnd, now);
      const on = inMinTempOverride || fixed.isOn;

      this._patchRuntime(planId, {
        planState: 'planned',
        fixedWindowStart: profile.fixedWindowStart,
        fixedWindowEnd: profile.fixedWindowEnd,
        fixedMinTempTriggered: inMinTempOverride,
        heaterShouldBeOn: on,
        updatedAt: now.toISOString(),
      });

      return on;
    }

    const plan = this._readPlan(planId);
    if (plan.state !== 'planned' || !plan.start || !plan.end) {
      this._patchRuntime(planId, {
        heaterShouldBeOn: false,
        updatedAt: new Date().toISOString(),
      });
      return false;
    }
    const now = new Date();
    const on = now >= plan.start && now < plan.end;
    this._patchRuntime(planId, {
      planState: plan.state,
      planWindowStart: plan.start.toISOString(),
      planWindowEnd: plan.end.toISOString(),
      heaterShouldBeOn: on,
      updatedAt: now.toISOString(),
    });
    return on;
  }

  async _syncHeatingStateAndTrigger(planId, source) {
    const profileId = this._sanitizeProfileId(planId);
    const runtime = this._getRuntime(profileId) || {};
    const hadPrevious = typeof runtime.heaterShouldBeOn === 'boolean';
    const previous = !!runtime.heaterShouldBeOn;
    const next = this._isHeatingNow(profileId);
    const profile = this._getProfiles().find((p) => p.id === profileId);

    if (profile) {
      try {
        await this._maybeMarkGoalReachedFromPower(profile, next, source || 'state-sync');
      } catch (err) {
        this.error(`[${profileId}] Failed power-based goal detection:`, err.message);
      }
    }

    const now = new Date();
    const lastApply = runtime.controlLastAppliedAt ? new Date(runtime.controlLastAppliedAt) : null;
    const shouldReassert = !lastApply || isNaN(lastApply.getTime()) || ((now.getTime() - lastApply.getTime()) > 30 * 60 * 1000);

    if (!hadPrevious || previous === next) {
      if (!hadPrevious || shouldReassert) {
        this._applyProfileControl(profileId, next, source || 'state-sync', true).catch((err) => {
          this.error(`[${profileId}] Failed to apply heater control:`, err.message);
        });
      }
      return next;
    }

    const tokens = {
      profile_id: profileId,
      profile_name: profile ? profile.name : profileId,
      should_heat: next,
      source: source || 'unknown',
    };
    const state = {
      profile_id: profileId,
      should_heat: next,
    };
    const card = next ? this.heatingShouldTurnOnCard : this.heatingShouldTurnOffCard;
    if (card) {
      card.trigger(tokens, state).catch((err) => {
        this.error(`[${profileId}] Failed to trigger heating transition card:`, err.message);
      });
    }

    this._applyProfileControl(profileId, next, source || 'state-change', true).catch((err) => {
      this.error(`[${profileId}] Failed to apply heater control:`, err.message);
    });

    this.log(`[${profileId}] Heating state changed ${previous ? 'ON' : 'OFF'} -> ${next ? 'ON' : 'OFF'} (${source || 'unknown'})`);
    return next;
  }

  async _applyProfileControl(profileId, shouldHeat, source, force = false) {
    const profile = this._getProfiles().find((p) => p.id === profileId);
    if (!profile) return;
    if (!profile.controlDeviceId) return;

    const runtime = this._getRuntime(profileId) || {};
    if (!force && typeof runtime.controlAppliedOn === 'boolean' && runtime.controlAppliedOn === !!shouldHeat) {
      return;
    }

    const devices = await this._getAllDevices();
    const device = devices[profile.controlDeviceId];
    if (!device) {
      throw new Error(`Control device not found: ${profile.controlDeviceId}`);
    }

    const capabilityId = profile.controlCapabilityId || 'onoff';
    const value = !!shouldHeat;

    if (typeof device.setCapabilityValue !== 'function') {
      throw new Error(`Control device does not support setCapabilityValue(): ${profile.controlDeviceId}`);
    }

    let verified = false;
    let lastReadRaw;
    let lastReadBool;
    let lastError;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await device.setCapabilityValue({ capabilityId, value });
        await this._delay(200 + attempt * 200);

        const freshDevices = await this._getAllDevices();
        const fresh = freshDevices[profile.controlDeviceId];
        const readVal = fresh && fresh.capabilitiesObj && fresh.capabilitiesObj[capabilityId]
          ? fresh.capabilitiesObj[capabilityId].value
          : undefined;
        lastReadRaw = readVal;
        lastReadBool = this._toBooleanControlValue(readVal);

        if (lastReadBool === value) {
          verified = true;
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (!verified) {
      const errMsg = `[${profileId}] Failed to verify control ${capabilityId}=${value ? 'ON' : 'OFF'} on ${profile.controlDeviceId}. `
        + `Last read: ${String(lastReadRaw)} (${String(lastReadBool)}).`
        + (lastError ? ` Error: ${lastError.message}` : '');
      await this._setControlError(profileId, errMsg, source || 'control-verify');
      throw new Error(errMsg);
    }

    this._patchRuntime(profileId, {
      controlAppliedOn: value,
      controlLastAppliedAt: new Date().toISOString(),
      controlDeviceId: profile.controlDeviceId,
      controlCapabilityId: capabilityId,
      controlError: null,
      controlErrorAt: null,
      updatedAt: new Date().toISOString(),
    });
    this.log(`[${profileId}] Applied and verified ${capabilityId}=${value ? 'ON' : 'OFF'} on ${profile.controlDeviceId} (${source || 'control'})`);
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _toBooleanControlValue(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'true' || v === 'on' || v === '1') return true;
      if (v === 'false' || v === 'off' || v === '0') return false;
    }
    return null;
  }

  async _setControlError(profileId, message, source) {
    const runtime = this._getRuntime(profileId) || {};
    const nowIso = new Date().toISOString();
    this._patchRuntime(profileId, {
      controlError: message,
      controlErrorAt: nowIso,
      controlErrorSource: source || 'unknown',
      updatedAt: nowIso,
    });

    const prev = runtime && runtime.controlError ? String(runtime.controlError) : '';
    if (prev === String(message)) return;

    try {
      await this.homey.notifications.createNotification({
        excerpt: `PricePilot: ${message}`,
      });
    } catch (err) {
      this.error(`[${profileId}] Failed to send control error notification:`, err.message);
    }
  }

  /*************************************************
   * HELPERS
   *************************************************/

  _computeHoursToHeat(currentTemp, targetTemp, heatingRate) {
    if (currentTemp >= targetTemp) return 0;
    // Use a conservative effective rate to better match real-world losses.
    const effectiveRate = heatingRate * 0.9;
    if (!Number.isFinite(effectiveRate) || effectiveRate <= 0) return 0;
    const rawHours = (targetTemp - currentTemp) / effectiveRate;
    // Round to 15-minute blocks and enforce a minimal useful run window.
    const quarterHours = Math.ceil(rawHours * 4);
    return Math.max(0.5, quarterHours / 4);
  }

  _isValidClockTime(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
  }

  _clockToMinutes(value) {
    const [hh, mm] = String(value || '').split(':').map((v) => Number(v));
    return hh * 60 + mm;
  }

  _atClockTime(baseDate, hhmm) {
    const d = new Date(baseDate.getTime());
    const mins = this._clockToMinutes(hhmm);
    d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    return d;
  }

  _computeFixedWindow(startHHMM, endHHMM, now = new Date()) {
    if (!this._isValidClockTime(startHHMM) || !this._isValidClockTime(endHHMM)) {
      throw new Error('Fixed window must use HH:MM format');
    }
    if (startHHMM === endHHMM) {
      throw new Error('Fixed window start and end cannot be equal');
    }

    const startMin = this._clockToMinutes(startHHMM);
    const endMin = this._clockToMinutes(endHHMM);
    const nowLocalMin = this._clockMinutesInAppTimeZone(now);
    const todayStart = this._atClockTime(now, startHHMM);
    const todayEnd = this._atClockTime(now, endHHMM);

    if (endMin > startMin) {
      if (nowLocalMin >= startMin && nowLocalMin < endMin) {
        return { start: todayStart, end: todayEnd, isOn: true };
      }
      if (nowLocalMin < startMin) {
        return { start: todayStart, end: todayEnd, isOn: false };
      }
      const nextStart = new Date(todayStart.getTime());
      const nextEnd = new Date(todayEnd.getTime());
      nextStart.setDate(nextStart.getDate() + 1);
      nextEnd.setDate(nextEnd.getDate() + 1);
      return { start: nextStart, end: nextEnd, isOn: false };
    }

    // Overnight window, e.g. 22:00 -> 06:00
    const tomorrowEnd = new Date(todayEnd.getTime());
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
    if (nowLocalMin >= startMin) {
      return { start: todayStart, end: tomorrowEnd, isOn: true };
    }
    if (nowLocalMin < endMin) {
      const yesterdayStart = new Date(todayStart.getTime());
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      return { start: yesterdayStart, end: todayEnd, isOn: true };
    }
    return { start: todayStart, end: tomorrowEnd, isOn: false };
  }

  _getAppTimeZone() {
    try {
      if (this.homey && this.homey.clock && typeof this.homey.clock.getTimezone === 'function') {
        const tz = this.homey.clock.getTimezone();
        if (tz && typeof tz === 'string') return tz;
      }
    } catch (err) {
      // Fall back to Oslo if timezone API is unavailable.
    }
    return OSLO_TZ;
  }

  _clockMinutesInAppTimeZone(date) {
    const tz = this._getAppTimeZone();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

    const get = (type) => {
      const part = parts.find((p) => p.type === type);
      return part ? Number(part.value) : 0;
    };

    return get('hour') * 60 + get('minute');
  }

  _computeHoursSinceGoal(planId, currentTemp, targetTemp, maxHoursSinceGoal) {
    const now = new Date();
    const runtime = this._getRuntime(planId);

    if (currentTemp >= targetTemp) {
      this._patchRuntime(planId, {
        lastReachedAt: now.toISOString(),
        hoursSinceGoal: 0,
        currentTemp,
        targetTemp,
        updatedAt: now.toISOString(),
      });
      return 0;
    }

    let hours = maxHoursSinceGoal;
    if (runtime && runtime.lastReachedAt) {
      const last = new Date(runtime.lastReachedAt);
      if (!isNaN(last.getTime())) {
        hours = Math.max(0, (now.getTime() - last.getTime()) / 3600000);
      }
    }

    this._patchRuntime(planId, {
      hoursSinceGoal: Number(hours.toFixed(2)),
      currentTemp,
      targetTemp,
      updatedAt: now.toISOString(),
    });

    return hours;
  }

  _getRuntimeMap() {
    const raw = this.homey.settings.get('boilerRuntime');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  }

  _getRuntime(planId) {
    const key = this._sanitizeProfileId(planId);
    const map = this._getRuntimeMap();
    return map[key] || null;
  }

  _patchRuntime(planId, patch) {
    const key = this._sanitizeProfileId(planId);
    const map = this._getRuntimeMap();
    const current = map[key] && typeof map[key] === 'object' ? map[key] : {};
    map[key] = { ...current, ...patch };
    this.homey.settings.set('boilerRuntime', map);
  }

  async _readCurrentTempFromProfile(profile) {
    if (!profile.tempDeviceId) {
      throw new Error(`Profile "${profile.name}" is missing temperature sensor device ID`);
    }
    if (!profile.tempCapabilityId) {
      throw new Error(`Profile "${profile.name}" is missing temperature capability ID`);
    }

    const devices = await this._getAllDevices();
    const device = devices[profile.tempDeviceId];
    if (!device) {
      throw new Error(`Temperature sensor device not found for profile "${profile.name}" (device ID: ${profile.tempDeviceId})`);
    }

    const cap = device.capabilitiesObj && device.capabilitiesObj[profile.tempCapabilityId];
    if (!cap) {
      throw new Error(`Capability "${profile.tempCapabilityId}" not found on "${device.name}"`);
    }

    const value = Number(cap.value);
    if (!Number.isFinite(value)) {
      throw new Error(`Capability "${profile.tempCapabilityId}" on "${device.name}" is not numeric`);
    }

    const correction = Number.isFinite(Number(profile.tempCorrection)) ? Number(profile.tempCorrection) : 0;
    const correctedValue = value + correction;

    this._patchRuntime(profile.id, {
      currentTemp: correctedValue,
      sensorRawTemp: value,
      tempCorrection: correction,
      updatedAt: new Date().toISOString(),
    });

    return correctedValue;
  }

  async _readCurrentPowerFromProfile(profile) {
    if (!profile.powerDeviceId || !profile.powerCapabilityId) {
      return null;
    }

    const devices = await this._getAllDevices();
    const device = devices[profile.powerDeviceId];
    if (!device) {
      throw new Error(`Power monitor device not found for profile "${profile.name}" (device ID: ${profile.powerDeviceId})`);
    }

    const cap = device.capabilitiesObj && device.capabilitiesObj[profile.powerCapabilityId];
    if (!cap) {
      throw new Error(`Power capability "${profile.powerCapabilityId}" not found on "${device.name}"`);
    }

    const value = Number(cap.value);
    if (!Number.isFinite(value)) {
      throw new Error(`Power capability "${profile.powerCapabilityId}" on "${device.name}" is not numeric`);
    }

    this._patchRuntime(profile.id, {
      currentPowerW: value,
      powerDeviceId: profile.powerDeviceId,
      powerCapabilityId: profile.powerCapabilityId,
      updatedAt: new Date().toISOString(),
    });

    return value;
  }

  async _maybeMarkGoalReachedFromPower(profile, shouldHeat, source) {
    if (!shouldHeat) return false;
    if (!profile.powerDeviceId || !profile.powerCapabilityId) return false;

    const runtime = this._getRuntime(profile.id) || {};
    if (runtime.controlAppliedOn !== true) return false;

    const lastApply = runtime.controlLastAppliedAt ? new Date(runtime.controlLastAppliedAt) : null;
    const poweredOnLongEnough = lastApply
      && !isNaN(lastApply.getTime())
      && ((Date.now() - lastApply.getTime()) >= POWER_GOAL_REACHED_MIN_ON_MINUTES * 60 * 1000);

    if (!poweredOnLongEnough) return false;

    const currentPowerW = await this._readCurrentPowerFromProfile(profile);
    if (!Number.isFinite(currentPowerW) || currentPowerW > POWER_GOAL_REACHED_MAX_WATTS) {
      return false;
    }

    const now = new Date();
    const lastReachedAt = runtime.lastReachedAt ? new Date(runtime.lastReachedAt) : null;
    const shouldLog = !lastReachedAt
      || isNaN(lastReachedAt.getTime())
      || ((now.getTime() - lastReachedAt.getTime()) > 10 * 60 * 1000);

    this._patchRuntime(profile.id, {
      lastReachedAt: now.toISOString(),
      hoursSinceGoal: 0,
      goalReachedSource: 'power_zero_while_on',
      goalReachedAt: now.toISOString(),
      goalReachedPowerW: currentPowerW,
      currentPowerW,
      updatedAt: now.toISOString(),
    });

    if (shouldLog) {
      this.log(`[${profile.id}] Goal marked reached from power monitor: ${currentPowerW}W while heater remains ON (${source || 'power-monitor'})`);
    }

    return true;
  }

  _computeHeatingRatePerHour(powerW, tankLiters) {
    const p = Number(powerW);
    const liters = Number(tankLiters);
    if (!Number.isFinite(p) || p <= 0) return NaN;
    if (!Number.isFinite(liters) || liters <= 0) return NaN;

    // 1 liter water needs ~1.163 Wh to increase by 1°C.
    return p / (1.163 * liters);
  }

  async _getAllDevices() {
    return this.homeyApi.devices.getDevices();
  }

  async _refreshSensorCatalog() {
    try {
      this.log('Refreshing device catalogs...');
      const devices = await this._getAllDevices();
      const deviceValues = Object.values(devices || {});
      this.log(`Device scan count: ${deviceValues.length}`);

      const catalog = [];
      const seen = new Set();
      const controlCatalog = [];
      const controlSeen = new Set();
      const powerCatalog = [];
      const powerSeen = new Set();
      let tempLikeCandidates = 0;

      for (const dev of deviceValues) {
        if (!dev || !dev.id) continue;

        const capsObj = dev.capabilitiesObj && typeof dev.capabilitiesObj === 'object' ? dev.capabilitiesObj : {};
        const capIdsFromObj = Object.keys(capsObj);
        const capIdsFromList = Array.isArray(dev.capabilities) ? dev.capabilities : [];
        const capIds = Array.from(new Set(capIdsFromObj.concat(capIdsFromList)));

        for (const capId of capIds) {
          const cap = capsObj[capId] || null;
          const capLc = String(capId).toLowerCase();
          const titleLc = String((cap && cap.title) || '').toLowerCase();

          const looksLikeOnOff = /(^|\.)onoff$/.test(capLc);
          if (looksLikeOnOff) {
            const controlKey = `${dev.id}::${capId}`;
            if (!controlSeen.has(controlKey)) {
              controlSeen.add(controlKey);
              controlCatalog.push({
                deviceId: dev.id,
                deviceName: dev.name || dev.id,
                capabilityId: capId,
                capabilityTitle: cap && cap.title ? String(cap.title) : capId,
                currentValue: (cap && cap.value !== undefined && cap.value !== null) ? cap.value : null,
              });
            }
          }

          const units = cap && cap.units ? String(cap.units).trim().toLowerCase() : '';
          const looksLikePower = capLc === 'measure_power'
            || capLc.endsWith('.measure_power')
            || (capLc.includes('power') && units === 'w')
            || titleLc.includes('watt')
            || (titleLc.includes('power') && units === 'w');
          if (looksLikePower) {
            const powerKey = `${dev.id}::${capId}`;
            if (!powerSeen.has(powerKey)) {
              powerSeen.add(powerKey);
              powerCatalog.push({
                deviceId: dev.id,
                deviceName: dev.name || dev.id,
                capabilityId: capId,
                capabilityTitle: cap && cap.title ? String(cap.title) : capId,
                currentValue: (cap && cap.value !== undefined && cap.value !== null) ? cap.value : null,
                units: (cap && cap.units) ? String(cap.units) : 'W',
              });
            }
          }

          // Exclude light_temperature (Zigbee colour temperature, not a real sensor)
          if (capLc === 'light_temperature') continue;
          const looksLikeTemp = capLc.includes('temp') || capLc.includes('temperature') || titleLc.includes('temp');
          if (!looksLikeTemp) continue;
          tempLikeCandidates++;

          const key = `${dev.id}::${capId}`;
          if (seen.has(key)) continue;
          seen.add(key);

          catalog.push({
            deviceId: dev.id,
            deviceName: dev.name || dev.id,
            capabilityId: capId,
            capabilityTitle: cap && cap.title ? String(cap.title) : capId,
            currentValue: (cap && cap.value !== undefined && cap.value !== null) ? cap.value : null,
            units: (cap && cap.units) ? String(cap.units) : null,
          });
        }
      }

      catalog.sort((a, b) => {
        const an = `${a.deviceName} ${a.capabilityId}`.toLowerCase();
        const bn = `${b.deviceName} ${b.capabilityId}`.toLowerCase();
        return an.localeCompare(bn);
      });

      controlCatalog.sort((a, b) => {
        const an = `${a.deviceName} ${a.capabilityId}`.toLowerCase();
        const bn = `${b.deviceName} ${b.capabilityId}`.toLowerCase();
        return an.localeCompare(bn);
      });

      powerCatalog.sort((a, b) => {
        const an = `${a.deviceName} ${a.capabilityId}`.toLowerCase();
        const bn = `${b.deviceName} ${b.capabilityId}`.toLowerCase();
        return an.localeCompare(bn);
      });

      this.log(`Temp-like capability candidates: ${tempLikeCandidates}`);
      this.log(`Sensor catalog entries stored: ${catalog.length}`);
      this.log(`Control catalog entries stored: ${controlCatalog.length}`);
      this.log(`Power catalog entries stored: ${powerCatalog.length}`);
      if (catalog.length > 0) {
        this.log(`First catalog entry: ${catalog[0].deviceName} :: ${catalog[0].capabilityId}`);
      }

      this.homey.settings.set('boilerSensorCatalog', catalog);
      this.homey.settings.set('boilerSensorCatalogUpdatedAt', new Date().toISOString());
      this.homey.settings.set('boilerSensorCatalogError', null);
      this.homey.settings.set('boilerControlCatalog', controlCatalog);
      this.homey.settings.set('boilerControlCatalogUpdatedAt', new Date().toISOString());
      this.homey.settings.set('boilerControlCatalogError', null);
      this.homey.settings.set('boilerPowerCatalog', powerCatalog);
      this.homey.settings.set('boilerPowerCatalogUpdatedAt', new Date().toISOString());
      this.homey.settings.set('boilerPowerCatalogError', null);
      return catalog;
    } catch (err) {
      this.homey.settings.set('boilerSensorCatalogError', err.message || String(err));
      this.homey.settings.set('boilerControlCatalogError', err.message || String(err));
      this.homey.settings.set('boilerPowerCatalogError', err.message || String(err));
      throw err;
    }
  }

  _storeNordpoolFetchSnapshot(area, currency, slots) {
    const fetchedAt = new Date().toISOString();
    const payload = {
      fetchedAt,
      area: String(area || ''),
      currency: String(currency || ''),
      count: Array.isArray(slots) ? slots.length : 0,
      slots: Array.isArray(slots) ? slots : [],
    };
    this._cachedAutoFetchedAt = fetchedAt;
    this.homey.settings.set('nordpoolLastFetch', payload);
    this.homey.settings.set('nordpoolLastFetchError', null);
  }

  _storeNordpoolFetchError(area, currency, err) {
    this.homey.settings.set('nordpoolLastFetchError', {
      at: new Date().toISOString(),
      area: String(area || ''),
      currency: String(currency || ''),
      message: err && err.message ? String(err.message) : String(err),
    });
  }

  async _fetchNordpoolForDebug() {
    const area = (this.homey.settings.get('areaId') || '').trim();
    const currency = (this.homey.settings.get('currency') || '').trim();

    if (!area || !currency) {
      this._storeNordpoolFetchError(area, currency, new Error('Area and currency must be configured before fetching Nordpool prices.'));
      return;
    }

    try {
      const slots = await fetchPriceSlots(area, currency);
      this._cachedAutoPriceSlots = slots;
      this._cachedAutoPriceArea = area;
      this._cachedAutoPriceCurrency = currency;
      this._storeNordpoolFetchSnapshot(area, currency, slots);
    } catch (err) {
      this._storeNordpoolFetchError(area, currency, err);
      throw err;
    }
  }

  _shouldRefreshNordpoolCache(area, currency) {
    if (this._cachedAutoPriceArea !== area || this._cachedAutoPriceCurrency !== currency) {
      return true;
    }

    if (!Array.isArray(this._cachedAutoPriceSlots) || this._cachedAutoPriceSlots.length === 0) {
      const snapshot = this.homey.settings.get('nordpoolLastFetch');
      const canReuseSnapshot = snapshot
        && snapshot.area === area
        && snapshot.currency === currency
        && Array.isArray(snapshot.slots)
        && snapshot.slots.length > 0;

      if (canReuseSnapshot) {
        this._cachedAutoPriceSlots = snapshot.slots;
        this._cachedAutoPriceArea = area;
        this._cachedAutoPriceCurrency = currency;
        this._cachedAutoFetchedAt = snapshot.fetchedAt || null;
      } else {
        return true;
      }
    }

    const fetchedAt = this._cachedAutoFetchedAt || (this.homey.settings.get('nordpoolLastFetch') || {}).fetchedAt;
    const fetchedDate = fetchedAt ? new Date(fetchedAt) : null;
    if (!fetchedDate || isNaN(fetchedDate.getTime())) {
      return true;
    }

    const ageHours = (Date.now() - fetchedDate.getTime()) / 3600000;
    if (!Number.isFinite(ageHours) || ageHours >= NORDPOOL_MAX_CACHE_AGE_HOURS) {
      return true;
    }

    // Daily refresh after the Nordpool publish window in Oslo time.
    const nowParts = this._getOsloDateParts(new Date());
    const fetchedParts = this._getOsloDateParts(fetchedDate);
    const nowAfterPublishWindow =
      nowParts.hour > NORDPOOL_PUBLISH_HOUR_OSLO
      || (nowParts.hour === NORDPOOL_PUBLISH_HOUR_OSLO && nowParts.minute >= NORDPOOL_PUBLISH_GRACE_MINUTES);

    const fetchedDay = `${fetchedParts.year}-${fetchedParts.month}-${fetchedParts.day}`;
    const today = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
    if (nowAfterPublishWindow && fetchedDay !== today) {
      return true;
    }

    return false;
  }

  _getOsloDateParts(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: OSLO_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

    const get = (type) => {
      const part = parts.find((p) => p.type === type);
      return part ? Number(part.value) : 0;
    };

    return {
      year: get('year'),
      month: String(get('month')).padStart(2, '0'),
      day: String(get('day')).padStart(2, '0'),
      hour: get('hour'),
      minute: get('minute'),
    };
  }

};
