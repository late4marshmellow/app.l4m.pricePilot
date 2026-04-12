'use strict';

const https = require('https');

const NORDPOOL_BASE = 'https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices?market=DayAhead';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Fetch today's and tomorrow's day-ahead prices from Nordpool and return them
 * as an array of price slots compatible with PricePilot's planning logic.
 *
 * @param {string} area     - Delivery area code, e.g. "NO1", "SE3", "FI"
 * @param {string} currency - ISO 4217 currency code, e.g. "NOK", "EUR", "SEK"
 * @returns {Promise<Array<{startsAt: string, endsAt: string, price: number, durationMinutes: number}>>}
 */
async function fetchPriceSlots(area, currency) {
  if (!area || !currency) {
    throw new Error('NordpoolClient: area and currency are required');
  }

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const urls = [
    buildUrl(today, area, currency),
    buildUrl(tomorrow, area, currency)
  ];

  const results = await Promise.all(
    urls.map(url => fetchJson(url).catch(() => null)) // tomorrow may 404 before ~13:00 Oslo time
  );

  const allEntries = results
    .filter(Boolean)
    .flatMap(json => json.multiAreaEntries || []);

  if (allEntries.length === 0) {
    throw new Error(`NordpoolClient: no price entries returned for area "${area}" in ${currency}`);
  }

  return entriesToSlots(allEntries, area);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildUrl(date, area, currency) {
  const d = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  return `${NORDPOOL_BASE}&date=${d}&currency=${currency}&deliveryArea=${area}`;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const attempt = (retriesLeft) => {
      const req = https.get(url, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          if (retriesLeft > 0) {
            setTimeout(() => attempt(retriesLeft - 1), 500);
            return;
          }
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            if (retriesLeft > 0) {
              setTimeout(() => attempt(retriesLeft - 1), 500);
              return;
            }
            reject(new Error(`JSON parse error: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        if (retriesLeft > 0) {
          setTimeout(() => attempt(retriesLeft - 1), 500);
          return;
        }
        reject(err);
      });

      req.setTimeout(DEFAULT_TIMEOUT_MS, () => {
        req.destroy(new Error(`Timeout after ${DEFAULT_TIMEOUT_MS}ms`));
      });
    };

    attempt(2);
  });
}

/**
 * Convert raw Nordpool multiAreaEntries to PricePilot-compatible slots.
 * Nordpool prices are in <currency>/MWh; we divide by 1000 to get per kWh.
 * The API returns 15-minute slots; durationMinutes is derived from deliveryEnd.
 */
function entriesToSlots(entries, area) {
  const slots = entries
    .map(entry => {
      const pricePerMWh = entry.entryPerArea?.[area];
      if (typeof pricePerMWh !== 'number') return null;

      const startsAt = new Date(entry.deliveryStart);
      const endsAt   = new Date(entry.deliveryEnd);
      const durationMinutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60000);

      return {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        price: pricePerMWh / 1000, // convert MWh → kWh
        durationMinutes
      };
    })
    .filter(Boolean);

  // Sort chronologically and deduplicate by startsAt
  const seen = new Set();
  return slots
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .filter(s => {
      if (seen.has(s.startsAt)) return false;
      seen.add(s.startsAt);
      return true;
    });
}

module.exports = { fetchPriceSlots };
