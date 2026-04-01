/**
 * Country/Flag helpers — copied from Sentinel SDK js-sdk/app-helpers.js
 * 80+ countries confirmed on the Sentinel network as of 2026-03.
 */

// ─── Country Name → ISO Code Map ────────────────────────────────────────────

export const COUNTRY_MAP = Object.freeze({
  // Standard names
  'united states': 'US', 'germany': 'DE', 'france': 'FR', 'united kingdom': 'GB',
  'netherlands': 'NL', 'canada': 'CA', 'japan': 'JP', 'singapore': 'SG',
  'australia': 'AU', 'brazil': 'BR', 'india': 'IN', 'south korea': 'KR',
  'turkey': 'TR', 'romania': 'RO', 'poland': 'PL', 'spain': 'ES',
  'italy': 'IT', 'sweden': 'SE', 'norway': 'NO', 'finland': 'FI',
  'switzerland': 'CH', 'austria': 'AT', 'ireland': 'IE', 'portugal': 'PT',
  'czech republic': 'CZ', 'hungary': 'HU', 'bulgaria': 'BG', 'greece': 'GR',
  'ukraine': 'UA', 'russia': 'RU', 'hong kong': 'HK', 'taiwan': 'TW',
  'thailand': 'TH', 'vietnam': 'VN', 'indonesia': 'ID', 'philippines': 'PH',
  'mexico': 'MX', 'argentina': 'AR', 'chile': 'CL', 'colombia': 'CO',
  'south africa': 'ZA', 'israel': 'IL', 'united arab emirates': 'AE',
  'nigeria': 'NG', 'latvia': 'LV', 'lithuania': 'LT', 'estonia': 'EE',
  'croatia': 'HR', 'serbia': 'RS', 'denmark': 'DK', 'belgium': 'BE',
  'luxembourg': 'LU', 'malta': 'MT', 'cyprus': 'CY', 'iceland': 'IS',
  'new zealand': 'NZ', 'malaysia': 'MY', 'bangladesh': 'BD', 'pakistan': 'PK',
  'egypt': 'EG', 'kenya': 'KE', 'morocco': 'MA', 'peru': 'PE',
  'venezuela': 'VE', 'georgia': 'GE', 'guatemala': 'GT', 'puerto rico': 'PR',
  'china': 'CN', 'saudi arabia': 'SA', 'kazakhstan': 'KZ', 'mongolia': 'MN',
  'slovakia': 'SK', 'albania': 'AL', 'moldova': 'MD', 'jamaica': 'JM',
  'bolivia': 'BO', 'ecuador': 'EC', 'uruguay': 'UY', 'bahrain': 'BH',
  'dr congo': 'CD', 'costa rica': 'CR', 'panama': 'PA', 'paraguay': 'PY',
  'dominican republic': 'DO', 'el salvador': 'SV', 'honduras': 'HN',
  'nicaragua': 'NI', 'cuba': 'CU', 'haiti': 'HT', 'trinidad and tobago': 'TT',
  'kyrgyzstan': 'KG', 'uzbekistan': 'UZ', 'tajikistan': 'TJ',
  'bosnia and herzegovina': 'BA', 'north macedonia': 'MK', 'montenegro': 'ME',
  'kosovo': 'XK', 'slovenia': 'SI',

  // Variant names the chain returns
  'the netherlands': 'NL', 'türkiye': 'TR', 'turkiye': 'TR', 'czechia': 'CZ',
  'russian federation': 'RU', 'viet nam': 'VN', 'korea': 'KR',
  'republic of korea': 'KR', 'uae': 'AE', 'uk': 'GB', 'usa': 'US',
  'democratic republic of the congo': 'CD', 'congo': 'CD',

  // Short codes (some nodes return these)
  'us': 'US', 'de': 'DE', 'fr': 'FR', 'gb': 'GB', 'nl': 'NL', 'ca': 'CA',
  'jp': 'JP', 'sg': 'SG', 'au': 'AU', 'br': 'BR', 'in': 'IN', 'kr': 'KR',
  'tr': 'TR', 'ro': 'RO', 'pl': 'PL', 'es': 'ES', 'it': 'IT', 'se': 'SE',
  'no': 'NO', 'fi': 'FI', 'ch': 'CH', 'at': 'AT', 'ie': 'IE', 'pt': 'PT',
  'cz': 'CZ', 'hu': 'HU', 'bg': 'BG', 'gr': 'GR', 'ua': 'UA', 'ru': 'RU',
  'hk': 'HK', 'tw': 'TW', 'th': 'TH', 'vn': 'VN', 'id': 'ID', 'ph': 'PH',
  'mx': 'MX', 'ar': 'AR', 'cl': 'CL', 'co': 'CO', 'za': 'ZA', 'il': 'IL',
  'ae': 'AE', 'ng': 'NG', 'lv': 'LV', 'lt': 'LT', 'ee': 'EE', 'hr': 'HR',
  'rs': 'RS', 'dk': 'DK', 'be': 'BE', 'lu': 'LU', 'mt': 'MT', 'cy': 'CY',
  'is': 'IS', 'nz': 'NZ', 'my': 'MY', 'bd': 'BD', 'pk': 'PK', 'eg': 'EG',
  'ke': 'KE', 'ma': 'MA', 'pe': 'PE', 've': 'VE', 'ge': 'GE', 'gt': 'GT',
  'pr': 'PR', 'cn': 'CN', 'sa': 'SA', 'kz': 'KZ', 'mn': 'MN', 'sk': 'SK',
  'al': 'AL', 'md': 'MD', 'jm': 'JM', 'bo': 'BO', 'ec': 'EC', 'uy': 'UY',
  'bh': 'BH', 'cd': 'CD', 'kg': 'KG', 'uz': 'UZ', 'tj': 'TJ',
});

/**
 * Convert a country name to ISO 3166-1 alpha-2 code.
 * Handles standard names, chain variants, and short codes.
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
  return null;
}

/**
 * Get flag image URL from flagcdn.com (for native apps where emoji doesn't render).
 */
export function getFlagUrl(code, width = 40) {
  if (!code || code.length !== 2) return '';
  return `https://flagcdn.com/w${width}/${code.toLowerCase()}.png`;
}

/**
 * Get emoji flag for a country code (for web/browser).
 */
export function getFlagEmoji(code) {
  if (!code || code.length !== 2) return '';
  const upper = code.toUpperCase();
  return String.fromCodePoint(upper.charCodeAt(0) + 0x1F1A5, upper.charCodeAt(1) + 0x1F1A5);
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
