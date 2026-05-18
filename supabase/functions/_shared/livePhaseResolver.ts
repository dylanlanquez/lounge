// Server-side mirror of src/lib/queries/appointmentLivePhases.ts.
//
// Resolves the LIVE booking-type phases for an appointment and
// projects them onto the appointment's start_at, producing the same
// {phase_index, label, patient_required, start_at, end_at} shape the
// email composer expects. The materialised lng_appointment_phases
// snapshot is FROZEN at booking time and silently drifts the moment
// an admin retunes a booking type, so the email used to show stale
// phase shapes weeks after the original booking. Sourcing live (from
// lng_booking_type_resolve, the same RPC the in-app popup uses) keeps
// the email and the staff-side Estimated-appointment-length sheet in
// lockstep.
//
// Trade-off, same as the client: live timing can diverge from the
// appointment's own end_at (which the conflict checker still reads
// from the materialised snapshot). That's by design — the email is
// the customer-facing service description, not the operational
// schedule.
//
// Returns [] when the service has no live phases configured yet, so
// the caller can fall back to the existing materialised-snapshot
// fetch path (best-effort) before deciding to omit the timeline.

export interface LivePhase {
  phase_index: number;
  label: string;
  patient_required: boolean;
  start_at: string;
  end_at: string;
}

interface AxisPins {
  service_type: string | null;
  repair_variant: string | null;
  product_key: string | null;
  arch: string | null;
  start_at: string;
}

interface RpcResolvedPhase {
  phase_index: number;
  label: string;
  patient_required: boolean;
  duration_default: number | null;
}

// Untyped Supabase client surface — same shape the
// _shared/emailRenderer's AdminClient uses, so we don't pull in
// supabase-js's circular types.
type AdminClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
};

/** Read live phases and project them onto the appointment's
 *  start_at. Returns [] on any soft failure (RPC error, no service
 *  type, no phases configured) so the caller can fall back without
 *  re-implementing the same defensive checks. */
export async function resolveLivePhasesForAppointment(
  admin: AdminClient,
  pins: AxisPins,
): Promise<LivePhase[]> {
  if (!pins.service_type) return [];
  const { data, error } = await admin.rpc('lng_booking_type_resolve', {
    p_service_type: pins.service_type,
    p_repair_variant: pins.repair_variant,
    p_product_key: pins.product_key,
    p_arch: pins.arch,
  });
  if (error || !Array.isArray(data) || data.length === 0) return [];
  const row = data[0] as { phases?: unknown };
  const phasesRaw = row.phases;
  if (!Array.isArray(phasesRaw) || phasesRaw.length === 0) return [];
  // RPC returns phases as jsonb — normalise to the strict shape we
  // need before projecting.
  const phases = phasesRaw
    .map((p): RpcResolvedPhase | null => {
      if (!p || typeof p !== 'object') return null;
      const obj = p as Record<string, unknown>;
      const idx = typeof obj.phase_index === 'number' ? obj.phase_index : null;
      const label = typeof obj.label === 'string' ? obj.label : null;
      if (idx === null || label === null) return null;
      return {
        phase_index: idx,
        label,
        patient_required: obj.patient_required === true,
        duration_default:
          typeof obj.duration_default === 'number' ? obj.duration_default : null,
      };
    })
    .filter((p): p is RpcResolvedPhase => p !== null)
    .sort((a, b) => a.phase_index - b.phase_index);
  if (phases.length === 0) return [];
  // Project durations onto the appointment's start. Each phase's
  // start_at is the cumulative sum of prior phases' duration_default
  // (in minutes) added to the appointment's start_at. A phase with
  // null / non-positive duration_default still gets a slot — we
  // treat it as zero-length so it doesn't NaN the chain.
  const out: LivePhase[] = [];
  let cursorMs = new Date(pins.start_at).getTime();
  for (const p of phases) {
    const dur = Math.max(0, Math.round(p.duration_default ?? 0));
    const startMs = cursorMs;
    const endMs = cursorMs + dur * 60_000;
    out.push({
      phase_index: p.phase_index,
      label: p.label,
      patient_required: p.patient_required,
      start_at: new Date(startMs).toISOString(),
      end_at: new Date(endMs).toISOString(),
    });
    cursorMs = endMs;
  }
  return out;
}
