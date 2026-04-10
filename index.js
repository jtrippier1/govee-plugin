'use strict';

const https = require('https');

const PLUGIN_NAME = 'homebridge-govee-h6008';
const PLATFORM_NAME = 'GoveeH6008';

const GOVEE_API_HOST = 'developer-api.govee.com';
const GOVEE_API_BASE = '/v1/devices';

// Govee color temp range in Kelvin → mireds
const MIN_KELVIN = 2700;
const MAX_KELVIN = 6500;
const MIN_MIREDS = Math.ceil(1000000 / MAX_KELVIN);   // ~154
const MAX_MIREDS = Math.floor(1000000 / MIN_KELVIN);  // ~370

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_POLL_INTERVAL_S = 30;
const REQUEST_INTERVAL_MS = 600; // min gap between outgoing API requests (100 req/min limit)

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, GoveePlatform);
};

// Serializes API calls with a minimum interval between them to avoid rate limits.
class ApiQueue {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this._chain = Promise.resolve();
  }

  add(fn) {
    const result = this._chain
      .then(() => sleep(this.intervalMs))
      .then(fn);
    // Errors must not break the chain for subsequent requests
    this._chain = result.catch(() => {});
    return result;
  }
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

class GoveePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = new Map(); // uuid → PlatformAccessory

    if (!config || !config.apiKey) {
      this.log.error('No Govee API key configured. Add "apiKey" to your config.json platform entry.');
      return;
    }

    this.apiKey = config.apiKey;
    this.pollIntervalMs = (config.pollInterval || DEFAULT_POLL_INTERVAL_S) * 1000;
    this.queue = new ApiQueue(REQUEST_INTERVAL_MS);

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  // Called by Homebridge for each cached accessory on startup
  configureAccessory(accessory) {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    let devices;
    try {
      const response = await this.goveeRequest('GET', '/');
      devices = response.data?.devices ?? [];
    } catch (err) {
      this.log.error('Failed to fetch devices from Govee API:', err.message);
      return;
    }

    if (!devices.length) {
      this.log.warn('No devices returned from Govee API.');
      return;
    }

    const activeUUIDs = new Set();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.device);
      activeUUIDs.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (accessory) {
        this.log.info('Updating existing accessory:', device.deviceName);
        accessory.context.device = device;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Registering new accessory:', device.deviceName);
        accessory = new this.api.platformAccessory(device.deviceName, uuid);
        accessory.context.device = device;
        this.accessories.set(uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.setupAccessory(accessory, device);

      // Sync real device state immediately on startup
      try {
        await this.refreshDeviceState(accessory, device);
      } catch (err) {
        this.log.warn(`Could not sync initial state for ${device.deviceName}:`, err.message);
      }
    }

    // Remove accessories no longer returned by the API
    for (const [uuid, accessory] of this.accessories) {
      if (!activeUUIDs.has(uuid)) {
        this.log.info('Removing stale accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }

    // Schedule ongoing polling
    setInterval(() => this.pollAllDevices(), this.pollIntervalMs);
  }

  setupAccessory(accessory, device) {
    const { Service, Characteristic } = this.api.hap;

    // AccessoryInformation
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Govee')
      .setCharacteristic(Characteristic.Model, device.model)
      .setCharacteristic(Characteristic.SerialNumber, device.device);

    // Ensure Lightbulb service exists
    const service =
      accessory.getService(Service.Lightbulb) ||
      accessory.addService(Service.Lightbulb, device.deviceName);

    // Initialize cached state (preserved across restarts via accessory.context)
    if (!accessory.context.state) {
      accessory.context.state = {
        on: false,
        brightness: 100,  // 0–100
        hue: 0,           // 0–360
        saturation: 0,    // 0–100
        colorTemp: MAX_MIREDS, // mireds, default warm white
        colorMode: false, // false = colorTemp mode, true = color mode
      };
    }

    const state = accessory.context.state;

    // --- On/Off ---
    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => state.on)
      .onSet((value) => {
        state.on = !!value;
        this.sendCommand(device, 'turn', value ? 'on' : 'off').catch((err) => {
          this.log.error(`Failed to set power for ${device.deviceName}:`, err.message);
        });
      });

    // --- Brightness ---
    service
      .getCharacteristic(Characteristic.Brightness)
      .onGet(() => state.brightness)
      .onSet((value) => {
        state.brightness = value;
        this.sendCommand(device, 'brightness', value).catch((err) => {
          this.log.error(`Failed to set brightness for ${device.deviceName}:`, err.message);
        });
      });

    // --- Hue ---
    // Debounce together with Saturation to avoid two API calls per color pick
    service
      .getCharacteristic(Characteristic.Hue)
      .onGet(() => state.hue)
      .onSet((value) => {
        state.hue = value;
        state.colorMode = true;
        this.scheduleColorCommand(accessory, device);
      });

    // --- Saturation ---
    service
      .getCharacteristic(Characteristic.Saturation)
      .onGet(() => state.saturation)
      .onSet((value) => {
        state.saturation = value;
        state.colorMode = true;
        this.scheduleColorCommand(accessory, device);
      });

    // --- Color Temperature ---
    service
      .getCharacteristic(Characteristic.ColorTemperature)
      .setProps({ minValue: MIN_MIREDS, maxValue: MAX_MIREDS })
      .onGet(() => state.colorTemp)
      .onSet((value) => {
        state.colorTemp = value;
        state.colorMode = false;
        const kelvin = Math.round(1000000 / value);
        this.sendCommand(device, 'colorTem', kelvin).catch((err) => {
          this.log.error(`Failed to set color temp for ${device.deviceName}:`, err.message);
        });
      });

    // --- Adaptive Lighting ---
    // Lets HomeKit automatically shift color temperature throughout the day.
    // Only configure once — context flag survives restarts.
    if (this.api.hap.AdaptiveLightingController && !accessory.context.adaptiveLightingConfigured) {
      const adaptiveLighting = new this.api.hap.AdaptiveLightingController(service);
      accessory.configureController(adaptiveLighting);
      accessory.context.adaptiveLightingConfigured = true;
      this.log.debug('Adaptive lighting enabled for', device.deviceName);
    }
  }

  // Debounce color commands so Hue + Saturation changes send one API call
  scheduleColorCommand(accessory, device) {
    if (accessory.context.colorDebounceTimer) {
      clearTimeout(accessory.context.colorDebounceTimer);
    }
    accessory.context.colorDebounceTimer = setTimeout(async () => {
      accessory.context.colorDebounceTimer = null;
      const { hue, saturation } = accessory.context.state;
      const rgb = hsbToRgb(hue, saturation, 100);
      await this.sendCommand(device, 'color', rgb).catch((err) => {
        this.log.error(`Color command failed for ${device.deviceName}:`, err.message);
      });
    }, 300);
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  async pollAllDevices() {
    for (const accessory of this.accessories.values()) {
      const device = accessory.context.device;
      if (!device) continue;
      try {
        await this.refreshDeviceState(accessory, device);
      } catch (err) {
        this.log.debug(`State poll failed for ${device.deviceName}:`, err.message);
      }
    }
  }

  async refreshDeviceState(accessory, device) {
    const path = `/state?device=${encodeURIComponent(device.device)}&model=${encodeURIComponent(device.model)}`;
    const response = await this.goveeRequest('GET', path);
    const properties = response.data?.properties ?? [];

    const { Service, Characteristic } = this.api.hap;
    const service = accessory.getService(Service.Lightbulb);
    if (!service) return;

    const state = accessory.context.state;

    for (const prop of properties) {
      if (prop.powerState !== undefined) {
        state.on = prop.powerState === 'on';
        service.updateCharacteristic(Characteristic.On, state.on);
      }

      if (prop.brightness !== undefined) {
        state.brightness = clamp(prop.brightness, 0, 100);
        service.updateCharacteristic(Characteristic.Brightness, state.brightness);
      }

      if (prop.color !== undefined) {
        const { r, g, b } = prop.color;
        const { h, s } = rgbToHsb(r, g, b);
        state.hue = Math.round(h);
        state.saturation = Math.round(s);
        state.colorMode = true;
        service.updateCharacteristic(Characteristic.Hue, state.hue);
        service.updateCharacteristic(Characteristic.Saturation, state.saturation);
      }

      if (prop.colorTemInKelvin !== undefined && prop.colorTemInKelvin > 0) {
        const mireds = Math.round(1000000 / prop.colorTemInKelvin);
        state.colorTemp = clamp(mireds, MIN_MIREDS, MAX_MIREDS);
        state.colorMode = false;
        service.updateCharacteristic(Characteristic.ColorTemperature, state.colorTemp);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // API communication
  // ---------------------------------------------------------------------------

  async sendCommand(device, name, value) {
    const body = JSON.stringify({
      device: device.device,
      model: device.model,
      cmd: { name, value },
    });
    await this.goveeRequest('PUT', '/control', body);
    this.log.debug(`${device.deviceName} ← ${name}:`, JSON.stringify(value));
  }

  goveeRequest(method, path, body = null) {
    return this.queue.add(() => this._requestWithRetry(method, path, body));
  }

  async _requestWithRetry(method, path, body) {
    let rateLimitRetries = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this._rawRequest(method, path, body);
      } catch (err) {
        // Rate limited — wait exactly as long as Govee says, then retry
        if (err.retryAfter !== undefined && rateLimitRetries < 2) {
          rateLimitRetries++;
          this.log.warn(`Rate limited by Govee API, waiting ${err.retryAfter}s...`);
          await sleep((err.retryAfter + 1) * 1000);
          attempt--; // don't consume a normal retry slot
          continue;
        }
        if (attempt === MAX_RETRIES) throw err;
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        this.log.debug(`Request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms:`, err.message);
        await sleep(delay);
      }
    }
  }

  _rawRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: GOVEE_API_HOST,
        path: GOVEE_API_BASE + path,
        method,
        headers: {
          'Govee-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
      };

      if (body) {
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          // Handle rate limit before attempting JSON parse (response is plain text)
          if (res.statusCode === 429) {
            const match = raw.match(/retry in (\d+)/i);
            const retryAfter = match ? parseInt(match[1]) : 60;
            const err = new Error(`Rate limited by Govee API (retry in ${retryAfter}s)`);
            err.retryAfter = retryAfter;
            return reject(err);
          }
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return reject(new Error(`Non-JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`));
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${parsed.message ?? raw.slice(0, 200)}`));
          }
        });
      });

      req.setTimeout(10000, () => {
        req.destroy(new Error('Request timed out after 10s'));
      });

      req.on('error', reject);

      if (body) req.write(body);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Color conversion helpers
// ---------------------------------------------------------------------------

// Hue 0–360, Saturation 0–100, Brightness 0–100 → { r, g, b } 0–255
function hsbToRgb(hue, saturation, brightness) {
  const s = saturation / 100;
  const v = brightness / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;

  let r = 0, g = 0, b = 0;
  if      (hue < 60)  { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else                { r = c; g = 0; b = x; }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

// { r, g, b } 0–255 → { h: 0–360, s: 0–100, v: 0–100 }
function rgbToHsb(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if      (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
  }

  return {
    h: h * 360,
    s: max === 0 ? 0 : (d / max) * 100,
    v: max * 100,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
