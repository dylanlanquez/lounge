import { supabase } from '../supabase.ts';
import type { BookingServiceType } from './bookingTypes.ts';

// Client wrapper around the lng_booking_available_slots RPC. Used by
// the New booking + Reschedule sheets so the TimePicker shows only
// slots that pass lng_booking_check_conflict — instead of every slot
// in working hours plus a "this one's actually booked" banner after
// the fact.
//
// The RPC returns HH:MM 24-hour strings keyed to the same grid the
// TimePicker builds, so caller can filter its slot list by set
// membership with no timezone arithmetic on the client.

export interface AvailableSlotsArgs {
  locationId: string;
  serviceType: BookingServiceType;
  // YYYY-MM-DD; the date the slots are being computed for.
  date: string;
  // Reschedule sheets pass the row being moved so its current slot
  // is reported as available (it doesn't conflict with itself).
  excludeAppointmentId?: string | null;
  repairVariant?: string | null;
  productKey?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
  // Step granularity in minutes. Defaults to the picker's 15.
  stepMinutes?: number;
}

export async function loadAvailableSlots(
  args: AvailableSlotsArgs,
): Promise<string[]> {
  const { data, error } = await supabase.rpc(
    'lng_booking_available_slots',
    {
      p_location_id: args.locationId,
      p_service_type: args.serviceType,
      p_date: args.date,
      p_exclude_appointment_id: args.excludeAppointmentId ?? null,
      p_repair_variant: args.repairVariant ?? null,
      p_product_key: args.productKey ?? null,
      p_arch: args.arch ?? null,
      p_step_minutes: args.stepMinutes ?? 15,
    },
  );
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) return [];
  return data
    .map((r) => (r as { slot_local: string }).slot_local)
    .filter((s): s is string => typeof s === 'string');
}
