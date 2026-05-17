// Map a Calendly event-type name (e.g. "Same-day Appliances",
// "Virtual Impression Appointment") to the canonical Lounge
// service_type enum that drives phase resolution + resource pool
// conflict checks.
//
// Why this matters: lng_materialise_appointment_phases keys off
// service_type to look up phase definitions. Without service_type,
// imported appointments land with zero rows in lng_appointment_phases,
// which means they consume zero pools per
// lng_booking_check_conflict, which means the customer widget will
// happily offer overlapping slots that should clash on the impression
// clinician + consultation room. See the audit on 2026-05-17.
//
// Match strategy: case-insensitive substring patterns ordered most
// specific first. Virtual + In-person both match the impression
// branch, so the "virtual" sub-check has to happen BEFORE the
// generic "impression" check.
//
// Returns null when no pattern matches — caller writes null and
// the row remains unphased rather than mismatched. Better to under-
// classify than to mislabel.
export function serviceTypeFromCalendlyLabel(
  label: string | null | undefined,
): string | null {
  if (!label) return null;
  const v = label.toLowerCase();
  if (/click[\s-]?in\s+veneer/.test(v)) return 'click_in_veneers';
  if (/denture\s+repair/.test(v)) return 'denture_repair';
  if (/same[\s-]?day\s+appliance/.test(v)) return 'same_day_appliance';
  if (/virtual\s+impression|impression.*virtual/.test(v)) {
    return 'virtual_impression_appointment';
  }
  if (/impression/.test(v)) return 'impression_appointment';
  return null;
}
