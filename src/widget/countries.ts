// Phone-country list for the widget Details step.
//
// Ordered roughly by likelihood for the Glasgow clinic's patient
// mix: home countries first, then English-speaking, EU, then
// dental-tourism markets (Middle East / Asia). Sorted alpha within
// groups so the panel reads predictably.
//
// Adding a country: pick the right ISO-3166 alpha-2 code, paste
// the dial code (no leading +), and pop in the regional flag
// emoji. The widget renders the flag via system font rendering so
// no build step needed.

export interface PhoneCountry {
  /** ISO-3166-1 alpha-2 code, e.g. 'GB'. */
  code: string;
  /** Regional indicator emoji. */
  flag: string;
  /** Dial code without the leading plus, e.g. '44'. */
  dial: string;
  /** English country name shown in the picker panel. */
  label: string;
  /** Minimum local-digit count (national subscriber number,
   *  excluding country code and any leading 0). Used for inline
   *  validation. Conservative — under-rejects borderline cases
   *  rather than blocking a valid number on a typo in our table. */
  minDigits: number;
}

export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  // Home + neighbours
  { code: 'GB', flag: '🇬🇧', dial: '44', label: 'United Kingdom', minDigits: 9 },
  { code: 'IE', flag: '🇮🇪', dial: '353', label: 'Ireland', minDigits: 8 },

  // English-speaking
  { code: 'US', flag: '🇺🇸', dial: '1', label: 'United States', minDigits: 10 },
  { code: 'CA', flag: '🇨🇦', dial: '1', label: 'Canada', minDigits: 10 },
  { code: 'AU', flag: '🇦🇺', dial: '61', label: 'Australia', minDigits: 9 },
  { code: 'NZ', flag: '🇳🇿', dial: '64', label: 'New Zealand', minDigits: 8 },

  // Western + Northern Europe
  { code: 'AT', flag: '🇦🇹', dial: '43', label: 'Austria', minDigits: 9 },
  { code: 'BE', flag: '🇧🇪', dial: '32', label: 'Belgium', minDigits: 8 },
  { code: 'CH', flag: '🇨🇭', dial: '41', label: 'Switzerland', minDigits: 9 },
  { code: 'DE', flag: '🇩🇪', dial: '49', label: 'Germany', minDigits: 10 },
  { code: 'DK', flag: '🇩🇰', dial: '45', label: 'Denmark', minDigits: 8 },
  { code: 'ES', flag: '🇪🇸', dial: '34', label: 'Spain', minDigits: 9 },
  { code: 'FI', flag: '🇫🇮', dial: '358', label: 'Finland', minDigits: 8 },
  { code: 'FR', flag: '🇫🇷', dial: '33', label: 'France', minDigits: 9 },
  { code: 'IT', flag: '🇮🇹', dial: '39', label: 'Italy', minDigits: 9 },
  { code: 'LU', flag: '🇱🇺', dial: '352', label: 'Luxembourg', minDigits: 8 },
  { code: 'NL', flag: '🇳🇱', dial: '31', label: 'Netherlands', minDigits: 9 },
  { code: 'NO', flag: '🇳🇴', dial: '47', label: 'Norway', minDigits: 8 },
  { code: 'PT', flag: '🇵🇹', dial: '351', label: 'Portugal', minDigits: 9 },
  { code: 'SE', flag: '🇸🇪', dial: '46', label: 'Sweden', minDigits: 8 },

  // Middle East
  { code: 'AE', flag: '🇦🇪', dial: '971', label: 'United Arab Emirates', minDigits: 8 },
  { code: 'BH', flag: '🇧🇭', dial: '973', label: 'Bahrain', minDigits: 8 },
  { code: 'KW', flag: '🇰🇼', dial: '965', label: 'Kuwait', minDigits: 7 },
  { code: 'OM', flag: '🇴🇲', dial: '968', label: 'Oman', minDigits: 8 },
  { code: 'QA', flag: '🇶🇦', dial: '974', label: 'Qatar', minDigits: 8 },
  { code: 'SA', flag: '🇸🇦', dial: '966', label: 'Saudi Arabia', minDigits: 9 },

  // Asia
  { code: 'HK', flag: '🇭🇰', dial: '852', label: 'Hong Kong', minDigits: 8 },
  { code: 'JP', flag: '🇯🇵', dial: '81', label: 'Japan', minDigits: 10 },
  { code: 'KR', flag: '🇰🇷', dial: '82', label: 'South Korea', minDigits: 9 },
  { code: 'SG', flag: '🇸🇬', dial: '65', label: 'Singapore', minDigits: 8 },
];

export function findCountry(code: string): PhoneCountry {
  return PHONE_COUNTRIES.find((c) => c.code === code) ?? PHONE_COUNTRIES[0]!;
}
