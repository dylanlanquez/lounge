import { useEffect, useState } from 'react';
import { resolveBookingTypeConfig } from './bookingTypes.ts';
import type { BookingServiceType } from './bookingTypes.ts';
import type { AppointmentPhaseSummary } from './appointments.ts';

// useAppointmentLivePhases — resolves the LIVE booking-type phases
// for an appointment (whatever the admin currently has set up in
// Admin → Booking Types) and projects them onto the appointment's
// start_at to produce time-anchored phase entries.
//
// Why live (and not the materialised lng_appointment_phases snapshot
// that's frozen at booking time): the "Estimated appointment length"
// modal on the appointment hero is a customer-facing description of
// "how this kind of appointment unfolds". Dylan's spec is explicit:
// "It should show this for each and every appointment based on
// what's currently live in Admin → Booking Types." A booking made
// before the admin extended Manufacture from 15 min → 4 h would
// otherwise display the stale 15-min number even after the admin
// has corrected the config, which is exactly the bug we caught
// when the modal first shipped sourcing from the snapshot.
//
// Trade-off: the live timeline can disagree with the appointment's
// own materialised end_at (which the conflict checker and schedule
// grid still read). That's by design here — the modal is for the
// patient-facing service description, not the operational schedule.
// The schedule grid keeps reading lng_appointment_phases so existing
// bookings don't have their conflict windows quietly shifted when
// the admin retunes a service.
//
// Return value:
//   • null   — still loading, or the appointment has no recognisable
//              service_type (Calendly imports without axis pins).
//   • []     — service resolved but no phases configured yet
//              (admin hasn't added any phases to this booking type).
//   • phases — one AppointmentPhaseSummary-shaped entry per live
//              phase, ordered by phase_index, with start_at/end_at
//              computed from appt.start_at + cumulative
//              duration_default minutes.
//
// We deliberately return the same shape as the materialised
// AppointmentPhaseSummary so the PhaseTimeline component stays
// source-agnostic and any future consumer (visit page, schedule
// preview) can switch between live + materialised without
// reshaping the data.

export interface AppointmentLivePhasesInput {
  service_type: string | null;
  repair_variant: string | null;
  product_key: string | null;
  arch: string | null;
  start_at: string;
}

interface State {
  phases: AppointmentPhaseSummary[] | null;
  loading: boolean;
  error: string | null;
}

export function useAppointmentLivePhases(
  input: AppointmentLivePhasesInput | null,
): State {
  const [state, setState] = useState<State>({
    phases: null,
    loading: !!input,
    error: null,
  });

  // Stable cache key so the effect doesn't re-fire on every render of
  // a parent that produces a fresh input object literal but the
  // values haven't actually changed.
  const cacheKey = input
    ? `${input.service_type ?? ''}|${input.repair_variant ?? ''}|${input.product_key ?? ''}|${input.arch ?? ''}|${input.start_at}`
    : '';

  useEffect(() => {
    if (!input || !input.service_type) {
      setState({ phases: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    (async () => {
      try {
        const resolved = await resolveBookingTypeConfig({
          service_type: input.service_type as BookingServiceType,
          repair_variant: input.repair_variant ?? null,
          product_key: input.product_key ?? null,
          arch: (input.arch as 'upper' | 'lower' | 'both' | null) ?? null,
        });
        if (cancelled) return;
        if (!resolved) {
          setState({ phases: [], loading: false, error: null });
          return;
        }
        setState({
          phases: projectPhasesOntoAppointment(resolved.phases, input.start_at),
          loading: false,
          error: null,
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          phases: null,
          loading: false,
          error: e instanceof Error ? e.message : 'Could not resolve booking type',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}

// Build time-anchored phase entries from a sequence of resolved
// phases (`ResolvedPhase[]` from the booking-type resolver) and an
// appointment's start_at. The cursor walks forward through the
// phases, advancing by each phase's duration_default minutes;
// each entry's start_at is the cursor before the advance and
// end_at is the cursor after.
//
// Phases with a null / zero / negative duration_default are skipped
// so a misconfigured booking type can't insert zero-length entries
// that would render as visual noise in the timeline. The output is
// re-keyed by phase_index from the resolver so callers can still
// match against the canonical sequence.
function projectPhasesOntoAppointment(
  resolved: Array<{
    phase_index: number;
    label: string;
    patient_required: boolean;
    duration_default: number | null;
  }>,
  startAtIso: string,
): AppointmentPhaseSummary[] {
  const startMs = new Date(startAtIso).getTime();
  if (!Number.isFinite(startMs)) return [];
  let cursorMs = startMs;
  const out: AppointmentPhaseSummary[] = [];
  // Sort defensively — the RPC orders by phase_index but JSON arrays
  // through PostgREST can sometimes lose ordering on round-trip.
  const ordered = [...resolved].sort((a, b) => a.phase_index - b.phase_index);
  for (const phase of ordered) {
    const minutes = phase.duration_default;
    if (typeof minutes !== 'number' || minutes <= 0) continue;
    const entryStartMs = cursorMs;
    cursorMs += minutes * 60_000;
    out.push({
      phase_index: phase.phase_index,
      label: phase.label,
      patient_required: phase.patient_required,
      start_at: new Date(entryStartMs).toISOString(),
      end_at: new Date(cursorMs).toISOString(),
      // Status / pool_ids are materialised-only concerns. The live
      // timeline is a customer-facing description, not an operational
      // state machine, so we fill these with neutral defaults.
      status: 'pending',
      pool_ids: [],
    });
  }
  return out;
}
