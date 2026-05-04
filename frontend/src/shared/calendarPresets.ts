// Holiday weight presets for the VolCalendar widget.
//
// Per M3.6 spec: the user picks from this list every time they add a
// holiday rather than typing a number from scratch. `weight: null`
// means "Custom" — the row exposes a numeric input. User-extended
// presets are a future improvement (BUGS_AND_IMPROVEMENTS).

export interface HolidayPreset {
  label: string;
  weight: number | null;
}

export const HOLIDAY_PRESETS: HolidayPreset[] = [
  { label: 'Full holiday', weight: 0.1 },
  { label: 'Half day',     weight: 0.5 },
  { label: 'Custom',       weight: null },
];

export const DEFAULT_PRESET = HOLIDAY_PRESETS[0];
