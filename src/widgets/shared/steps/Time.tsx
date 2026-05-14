import type { BookingStateApi } from '../state.ts';
import { SlotPicker } from '../SlotPicker.tsx';

// Time step — thin adapter around SlotPicker. Selection only updates
// state.slotIso; the footer Next button is the sole navigation
// control. Same pattern the rest of the booking flow uses (no
// auto-advance).

export function TimeStep({ api }: { api: BookingStateApi }) {
  const service = api.state.service;
  return (
    <SlotPicker
      locationId={api.state.location?.id ?? null}
      serviceType={service?.serviceType ?? null}
      durationMinutes={service?.durationMinutes ?? 30}
      repairVariant={api.state.axes.repair_variant ?? null}
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
