import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';
import { AddressAutocompleteField } from '../AddressAutocompleteField/AddressAutocompleteField.tsx';
import type { ParsedAddress } from '../../lib/useAddressAutocomplete.ts';
import { BottomSheet, Button } from '../index.ts';
import { supabase } from '../../lib/supabase.ts';
import { theme } from '../../theme/index.ts';
import type { CartItemRow } from '../../lib/queries/carts.ts';

// Shipping dispatch form — opens after "Finish visit → To be shipped" once
// the visit has been marked complete. Pre-populates from the patient's
// portal_ship_* profile fields; staff can override before confirming.
//
// On submit calls book-lng-shipment which:
//  1. Creates the DPD shipment
//  2. Stamps lng_visits with dispatch metadata
//  3. Inserts an LWO row into Checkpoint's shipping_queue
//  4. Sends the patient a dispatch email (if template enabled)
//
// Field limits: DPD labels are 35 chars per line — each input enforces
// this with an inline counter that turns red at the limit.

const MAX = 35;

interface ShipAddress {
  name:     string;
  address1: string;
  address2: string;
  city:     string;
  zip:      string;
}

export interface ShipVisitSheetProps {
  open:       boolean;
  onClose:    () => void;
  visitId:    string;
  patientId:  string;
  items:      CartItemRow[];
  staffName:  string;
  onShipped:  (result: { dispatch_ref: string; tracking_number: string | null; label_data: string | null }) => void;
}

export function ShipVisitSheet({
  open,
  onClose,
  visitId,
  patientId,
  items,
  staffName,
  onShipped,
}: ShipVisitSheetProps) {
  const [addr, setAddr] = useState<ShipAddress>({
    name: '', address1: '', address2: '', city: '', zip: '',
  });
  const [prefillLoading, setPrefillLoading] = useState(false);
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-populate from patient profile when sheet opens
  useEffect(() => {
    if (!open || !patientId) return;
    let cancelled = false;
    setPrefillLoading(true);
    (async () => {
      const { data } = await supabase
        .from('patients')
        .select('first_name, last_name, portal_ship_line1, portal_ship_line2, portal_ship_city, portal_ship_postcode, portal_ship_country_code')
        .eq('id', patientId)
        .maybeSingle();
      if (cancelled || !data) { setPrefillLoading(false); return; }
      const p = data as {
        first_name: string | null;
        last_name: string | null;
        portal_ship_line1: string | null;
        portal_ship_line2: string | null;
        portal_ship_city: string | null;
        portal_ship_postcode: string | null;
        portal_ship_country_code: string | null;
      };
      setAddr({
        name:     `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
        address1: p.portal_ship_line1 ?? '',
        address2: p.portal_ship_line2 ?? '',
        city:     p.portal_ship_city  ?? '',
        zip:      p.portal_ship_postcode ?? '',
      });
      setPrefillLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, patientId]);

  const handlePlaceSelected = (parsed: ParsedAddress) => {
    setAddr((a) => ({
      ...a,
      address1: parsed.address1.substring(0, MAX),
      address2: parsed.address2.substring(0, MAX),
      city:     parsed.city.substring(0, MAX),
      zip:      parsed.postcode,
    }));
  };

  const archSuffix = (arch: string | null) =>
    arch === 'both' ? ' (upper & lower)' : arch === 'upper' ? ' (upper)' : arch === 'lower' ? ' (lower)' : '';

  // Formatted labels for display in the sheet review list
  const itemLabels = items.map((it) => {
    const qty = it.quantity > 1 ? ` × ${it.quantity}` : '';
    return `${it.name}${archSuffix(it.arch)}${qty}`;
  });

  // Structured items sent to book-lng-shipment so it can build
  // dispatched_products for Checkpoint and itemLabels for the email.
  const structuredItems = items.map((it) => ({
    name: it.name,
    qty:  it.quantity,
    arch: it.arch ?? null,
  }));

  const canSubmit = addr.address1.trim().length > 0 && addr.zip.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<{
        ok: boolean;
        dispatch_ref?: string;
        tracking_number?: string | null;
        label_data?: string | null;
        error?: string;
      }>('book-lng-shipment', {
        body: {
          visit_id:         visitId,
          shipping_address: {
            name:         addr.name,
            address1:     addr.address1,
            address2:     addr.address2,
            city:         addr.city,
            zip:          addr.zip,
            country_code: 'GB',
          },
          items:      structuredItems,
          staff_name: staffName,
        },
      });
      if (fnErr || !data?.ok) {
        setError(data?.error ?? fnErr?.message ?? 'Dispatch failed. Please try again.');
        return;
      }
      onShipped({
        dispatch_ref:    data.dispatch_ref ?? '',
        tracking_number: data.tracking_number ?? null,
        label_data:      data.label_data ?? null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unexpected error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={() => !busy && onClose()}
      dismissable={!busy}
      title="Create shipping label"
      description="Review the delivery address and confirm. A DPD label will be generated and the patient notified."
      footer={
        <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={busy} disabled={!canSubmit}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Package size={16} aria-hidden />
              Create label &amp; ship
            </span>
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>

        {/* Items summary */}
        {itemLabels.length > 0 && (
          <div>
            <p style={{ margin: `0 0 ${theme.space[2]}px`, fontSize: theme.type.size.xs, fontWeight: theme.type.weight.medium, color: theme.color.inkMuted, textTransform: 'uppercase', letterSpacing: theme.type.tracking.wide }}>
              Items being shipped
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
              {itemLabels.map((label, i) => (
                <p key={i} style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.ink }}>
                  {label}
                </p>
              ))}
            </div>
          </div>
        )}

        <hr style={{ margin: 0, border: 'none', borderTop: `1px solid ${theme.color.border}` }} />

        {/* Address form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <p style={{ margin: 0, fontSize: theme.type.size.xs, fontWeight: theme.type.weight.medium, color: theme.color.inkMuted, textTransform: 'uppercase', letterSpacing: theme.type.tracking.wide }}>
            Delivery address
          </p>

          {prefillLoading ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              Loading patient address…
            </p>
          ) : null}

          <LabelledField label="Full name" maxLength={MAX} value={addr.name} onChange={(v) => setAddr((a) => ({ ...a, name: v }))} />

          <AddressAutocompleteField
            label="Address line 1"
            required
            value={addr.address1}
            onChange={(v) => setAddr((a) => ({ ...a, address1: v.substring(0, MAX) }))}
            onSelectPlace={handlePlaceSelected}
            helper={addr.address1.length >= MAX - 5 ? `${MAX - addr.address1.length} remaining` : undefined}
          />

          <LabelledField label="Address line 2" maxLength={MAX} value={addr.address2} onChange={(v) => setAddr((a) => ({ ...a, address2: v }))} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: theme.space[3] }}>
            <LabelledField label="City" maxLength={MAX} value={addr.city} onChange={(v) => setAddr((a) => ({ ...a, city: v }))} />
            <div style={{ minWidth: 120 }}>
              <LabelledField label="Postcode" maxLength={10} value={addr.zip} onChange={(v) => setAddr((a) => ({ ...a, zip: v }))} />
            </div>
          </div>
        </div>

        {error ? (
          <p role="alert" style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert, fontWeight: theme.type.weight.medium }}>
            {error}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}

// Inline labelled field with 35-char counter
function LabelledField({
  label,
  value,
  onChange,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
}) {
  const remaining = maxLength - value.length;
  const warn      = remaining <= 5;
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        cursor: 'text',
      }}
    >
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: theme.type.size.xs, fontWeight: theme.type.weight.medium, color: theme.color.inkMuted }}>
          {label}
        </span>
        {warn && (
          <span style={{ fontSize: theme.type.size.xs, color: remaining === 0 ? theme.color.alert : theme.color.inkMuted }}>
            {remaining}
          </span>
        )}
      </span>
      <input
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.currentTarget.value)}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          outline: 'none',
          padding: 0,
          fontFamily: 'inherit',
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
          width: '100%',
          minWidth: 0,
        }}
      />
    </label>
  );
}
