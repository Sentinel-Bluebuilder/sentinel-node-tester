/**
 * Country/Flag helpers — base map from Blue JS SDK, layered with tester-only
 * extras (Central Asia + Balkans) that should be upstreamed.
 */

import {
  COUNTRY_MAP as SDK_COUNTRY_MAP,
  countryNameToCode as sdkCountryNameToCode,
  getFlagUrl as sdkGetFlagUrl,
  getFlagEmoji as sdkGetFlagEmoji,
} from 'blue-js-sdk';

// ─── Country Name → ISO Code Map ────────────────────────────────────────────
// Tester-only extras not yet in SDK COUNTRY_MAP. PR candidate upstream.
const TESTER_COUNTRY_EXTRAS = {
  'kyrgyzstan': 'KG', 'uzbekistan': 'UZ', 'tajikistan': 'TJ',
  'bosnia and herzegovina': 'BA', 'north macedonia': 'MK', 'montenegro': 'ME',
  'kosovo': 'XK', 'slovenia': 'SI',
  // Short codes for the extras above
  'kg': 'KG', 'uz': 'UZ', 'tj': 'TJ',
};

export const COUNTRY_MAP = Object.freeze({ ...SDK_COUNTRY_MAP, ...TESTER_COUNTRY_EXTRAS });

/**
 * Convert a country name to ISO 3166-1 alpha-2 code.
 * Handles standard names, chain variants, and short codes.
 * Uses tester's superset map (SDK + extras) — falls through to SDK on miss.
 */
export function countryNameToCode(name) {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  const exact = COUNTRY_MAP[lower];
  if (exact) return exact;
  if (lower.length === 2) return lower.toUpperCase();
  for (const [key, code] of Object.entries(COUNTRY_MAP)) {
    if (key.length > 2 && (lower.includes(key) || key.includes(lower))) return code;
  }
  return sdkCountryNameToCode(name);
}

export const getFlagUrl = sdkGetFlagUrl;
export const getFlagEmoji = sdkGetFlagEmoji;

// ─── Country Code → Continent Map ──────────────────────────────────────────

const CONTINENT_BY_CODE = Object.freeze({
  // Europe
  DE: 'EU', FR: 'EU', GB: 'EU', NL: 'EU', ES: 'EU', IT: 'EU', SE: 'EU', NO: 'EU',
  FI: 'EU', CH: 'EU', AT: 'EU', IE: 'EU', PT: 'EU', CZ: 'EU', HU: 'EU', BG: 'EU',
  GR: 'EU', UA: 'EU', RU: 'EU', RO: 'EU', PL: 'EU', TR: 'EU', LV: 'EU', LT: 'EU',
  EE: 'EU', HR: 'EU', RS: 'EU', DK: 'EU', BE: 'EU', LU: 'EU', MT: 'EU', CY: 'EU',
  IS: 'EU', SK: 'EU', AL: 'EU', MD: 'EU', BA: 'EU', MK: 'EU', ME: 'EU', XK: 'EU',
  SI: 'EU', GE: 'EU',
  // Asia
  JP: 'AS', SG: 'AS', IN: 'AS', KR: 'AS', HK: 'AS', TW: 'AS', TH: 'AS', VN: 'AS',
  ID: 'AS', PH: 'AS', MY: 'AS', BD: 'AS', PK: 'AS', CN: 'AS', SA: 'AS', KZ: 'AS',
  MN: 'AS', IL: 'AS', AE: 'AS', KG: 'AS', UZ: 'AS', TJ: 'AS', BH: 'AS',
  // North America
  US: 'NA', CA: 'NA', MX: 'NA', GT: 'NA', PR: 'NA', JM: 'NA', CR: 'NA', PA: 'NA',
  DO: 'NA', SV: 'NA', HN: 'NA', NI: 'NA', CU: 'NA', HT: 'NA', TT: 'NA',
  // South America
  BR: 'SA', AR: 'SA', CL: 'SA', CO: 'SA', PE: 'SA', VE: 'SA', BO: 'SA', EC: 'SA',
  UY: 'SA', PY: 'SA',
  // Africa
  ZA: 'AF', NG: 'AF', EG: 'AF', KE: 'AF', MA: 'AF', CD: 'AF',
  // Oceania
  AU: 'OC', NZ: 'OC',
});

export const CONTINENT_NAMES = Object.freeze({
  EU: 'Europe', AS: 'Asia', NA: 'North America', SA: 'South America',
  AF: 'Africa', OC: 'Oceania', AN: 'Antarctica', ZZ: 'Unknown',
});

/**
 * Map a country (name or ISO code) to a continent code: EU/AS/NA/SA/AF/OC/ZZ.
 */
export function countryToContinent(country) {
  if (!country) return null;
  const code = country.length === 2 ? country.toUpperCase() : countryNameToCode(country);
  if (!code) return null;
  return CONTINENT_BY_CODE[code] || null;
}

/**
 * Group nodes by country. Returns sorted array of country groups.
 */
export function groupNodesByCountry(nodes) {
  const groups = {};
  for (const node of nodes) {
    const key = node.countryCode || countryNameToCode(node.country) || 'ZZ';
    if (!groups[key]) {
      groups[key] = {
        country: node.country || 'Unknown',
        countryCode: key,
        flagEmoji: getFlagEmoji(key),
        flagUrl: getFlagUrl(key),
        nodes: [],
      };
    }
    groups[key].nodes.push(node);
  }
  return Object.values(groups).sort((a, b) => {
    if (a.countryCode === 'ZZ') return 1;
    if (b.countryCode === 'ZZ') return -1;
    return b.nodes.length - a.nodes.length;
  });
}
