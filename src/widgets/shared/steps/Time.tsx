import type { BookingStateApi } from '../state.ts';
import { SlotPicker } from '../SlotPicker.tsx';

// Time step — thin adapter around SlotPicker. Selection only updates
// state.slotIso; the footer Next button is the sole navigation
// control. Same pattern the rest of the booking flow uses (no
// auto-advance).

export function TimeStep({ api }: { api: BookingStateApi }) {
  const service = api.state.service;
  // Distinct repair_variants present in the cart. Only meaningful
  // for denture_repair — the slot RPC uses this array to pick the
  // most restrictive variant (e.g. Relining when the cart mixes
  // Cracked + Relining) so the grid hides times the impression
  // clinician is busy. Empty array for every other service; the
  // server's denture_repair guard ignores it.
  const repairVariants =
    service?.serviceType === 'denture_repair'
      ? Array.from(
          new Set(
            api.state.repairItems
              .map((r) => r.repairVariant)
              .filter((v): v is string => !!v),
          ),
        )
      : null;
  return (
    <SlotPicker
      locationId={api.state.location?.id ?? null}
      serviceType={service?.serviceType ?? null}
      durationMinutes={service?.durationMinutes ?? 30}
      repairVariant={api.state.axes.repair_variant ?? null}
      repairVariants={repairVariants}
      productKey={api.state.axes.product_key ?? null}
      arch={api.state.axes.arch ?? null}
      selectedIso={api.state.slotIso}
      onPick={(iso) => {
        api.setState((prev) => ({ ...prev, slotIso: iso }));
      }}
      // Drop the "first availability" banner — the template doesn't
      // have a counterpart and customers reach Time after a deep-link
      // already committed them to a service.
      showFirstAvailableBanner={false}
    />
  );
}
