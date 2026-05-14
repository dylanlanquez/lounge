import { Box, Clock, Disc, ShieldCheck, Truck } from 'lucide-react';
import type { ComponentType } from 'react';

// Per-service "Included at no extra cost" lists. Mirrors the
// retainer-cart template's `.included-card-vt` block (lines 372–377
// + the included-benefit-vt rows further down).
//
// Hard-coded per service for v1. v2 will move this into a per-
// service config in `lng_booking_type_config` (or a sibling table)
// so admin can edit copy + line items without a deploy.

export interface IncludedPerk {
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  title: string;
  /** Optional subtitle — italic muted line under the title, e.g.
   *  "Delivered Friday, 15th May" or "Same day". Skipped if null. */
  subtitle?: string;
}

// Map keyed on `WidgetBookingType.serviceType`. Each value is the
// list of perks rendered as a card below the optional add-ons.
export const INCLUDED_PERKS: Record<string, IncludedPerk[]> = {
  same_day_appliance: [
    { icon: Clock, title: 'Same-day production' },
    { icon: Box,   title: 'On-site impressions or scans' },
    { icon: Disc,  title: 'Storage case' },
    { icon: ShieldCheck, title: '14-day warranty' },
  ],
  impression_appointment: [
    { icon: Clock, title: 'In-clinic digital scan' },
    { icon: Truck, title: 'Free postage of any appliance ordered later' },
    { icon: ShieldCheck, title: '14-day warranty on anything we make' },
  ],
  virtual_impression_appointment: [
    { icon: Clock, title: 'Live impression coaching over Google Meet' },
    { icon: Box,   title: 'Impression kit posted to your door' },
    { icon: Truck, title: '3-way shipping (kit out, scans back, finished appliance to you)' },
    { icon: Disc,  title: 'Storage case' },
    { icon: ShieldCheck, title: '14-day warranty' },
  ],
  click_in_veneers: [
    { icon: Clock, title: 'Same-day fit and adjust' },
    { icon: Disc,  title: 'Storage case' },
    { icon: ShieldCheck, title: '14-day warranty' },
  ],
  denture_repair: [
    { icon: Clock, title: 'While you wait, when possible' },
    { icon: ShieldCheck, title: '14-day warranty on the repair' },
  ],
  other: [],
};
