import type { BookingStateApi } from '../state.ts';
import { SlotPicker } from '../SlotPicker.tsx';

// Step 4 — Date and Time.
//
// Thin shim that adapts the booking state api to the reusable
// SlotPicker component. The picker itself is shared with the
// patient-side reschedule flow on /widget/manage; keeping its
// inputs prop-shaped means both flows render the same calendar +
// slot list without coupling to the booking-flow state.

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
        api.goNext();
      }}
    />
  );
}

