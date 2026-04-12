'use strict';

/**
 * All Nordpool day-ahead delivery areas, with their native currency.
 * Area codes are the exact strings accepted by the Nordpool dataportal API
 * (deliveryArea query parameter).
 *
 * Source: https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices
 */
const REGIONS = [
  // Norway
  { id: 'NO1', label: 'Norway – NO1 (Oslo / East)',   currency: 'NOK' },
  { id: 'NO2', label: 'Norway – NO2 (Kristiansand / South)', currency: 'NOK' },
  { id: 'NO3', label: 'Norway – NO3 (Trondheim / Middle)',    currency: 'NOK' },
  { id: 'NO4', label: 'Norway – NO4 (Tromsø / North)',        currency: 'NOK' },
  { id: 'NO5', label: 'Norway – NO5 (Bergen / West)',         currency: 'NOK' },

  // Sweden
  { id: 'SE1', label: 'Sweden – SE1 (Luleå)',      currency: 'SEK' },
  { id: 'SE2', label: 'Sweden – SE2 (Sundsvall)',  currency: 'SEK' },
  { id: 'SE3', label: 'Sweden – SE3 (Stockholm)',  currency: 'SEK' },
  { id: 'SE4', label: 'Sweden – SE4 (Malmö)',      currency: 'SEK' },

  // Denmark
  { id: 'DK1', label: 'Denmark – DK1 (West)',      currency: 'DKK' },
  { id: 'DK2', label: 'Denmark – DK2 (East)',      currency: 'DKK' },

  // Finland
  { id: 'FI',  label: 'Finland',                   currency: 'EUR' },

  // Baltic states
  { id: 'EE',  label: 'Estonia',                   currency: 'EUR' },
  { id: 'LV',  label: 'Latvia',                    currency: 'EUR' },
  { id: 'LT',  label: 'Lithuania',                 currency: 'EUR' },

  // Central/Western Europe
  { id: 'AT',  label: 'Austria',      currency: 'EUR' },
  { id: 'BE',  label: 'Belgium',      currency: 'EUR' },
  { id: 'FR',  label: 'France',       currency: 'EUR' },
  { id: 'GER', label: 'Germany',      currency: 'EUR' },
  { id: 'NL',  label: 'Netherlands',  currency: 'EUR' },
  { id: 'PL',  label: 'Poland',       currency: 'EUR' },

  // South-Eastern Europe
  { id: 'BG',  label: 'Bulgaria',     currency: 'EUR' },
  { id: 'TEL', label: 'TEL (South-Eastern Europe)',  currency: 'EUR' },
];

/**
 * Look up a region by its area code. Returns undefined if not found.
 * @param {string} areaId
 * @returns {{ id: string, label: string, currency: string } | undefined}
 */
function getRegion(areaId) {
  return REGIONS.find(r => r.id === areaId);
}

module.exports = { REGIONS, getRegion };
