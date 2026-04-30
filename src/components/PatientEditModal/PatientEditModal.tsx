import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Mail } from 'lucide-react';
import { Dialog } from '../Dialog/Dialog.tsx';
import { Input } from '../Input/Input.tsx';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';
import { staffUpdatePatient } from '../../lib/queries/patients.ts';

// Bag of every field the form touches, plus the patient id for the
// edit endpoint. Lounge keeps clinical fields editable here too — they
// always go straight to the patients row regardless of Shopify-link
// state, since Shopify doesn't model them.
export interface PatientEditModalPatient {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  shopify_customer_id: string | null;
  // Lounge-side fields the form needs to prefill. All optional; missing
  // fields render blank. Schema-tolerant so this works against both the
  // narrow PatientRow shape and the wider PatientProfileRow.
  sex?: string | null;
  allergies?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  communication_preferences?: string | null;
  notes?: string | null;
  portal_ship_line1?: string | null;
  portal_ship_line2?: string | null;
  portal_ship_city?: string | null;
  portal_ship_postcode?: string | null;
  portal_ship_country_code?: string | null;
}

// Which fieldset the modal exposes. Each section on the patient
// profile (the Hero card, the Care details card) opens the modal
// scoped to its own fields, so a pencil click reveals only what
// that surface owns — staff can't edit clinical notes from the
// identity card and vice versa.
export type PatientEditSection = 'profile' | 'care';

export interface PatientEditModalProps {
  open: boolean;
  patient: PatientEditModalPatient;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  // Which sub-form to render. 'profile' = identity + delivery
  // address. 'care' = vitals + kin + clinical notes. The save
  // payload narrows accordingly so the patient row only takes the
  // changes the user actually saw.
  section: PatientEditSection;
}

interface DraftIdentity {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  postcode: string;
  countryCode: string;
}

interface DraftClinical {
  dateOfBirth: string;
  sex: string;
  allergies: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  notes: string;
}

function emptyIdentity(p: PatientEditModalPatient): DraftIdentity {
  return {
    firstName: p.first_name ?? '',
    lastName: p.last_name ?? '',
    email: p.email ?? '',
    phone: p.phone ?? '',
    addressLine1: p.portal_ship_line1 ?? '',
    addressLine2: p.portal_ship_line2 ?? '',
    city: p.portal_ship_city ?? '',
    postcode: p.portal_ship_postcode ?? '',
    countryCode: p.portal_ship_country_code ?? '',
  };
}

function emptyClinical(p: PatientEditModalPatient): DraftClinical {
  return {
    dateOfBirth: p.date_of_birth ?? '',
    sex: p.sex ?? '',
    allergies: p.allergies ?? '',
    emergencyContactName: p.emergency_contact_name ?? '',
    emergencyContactPhone: p.emergency_contact_phone ?? '',
    notes: p.notes ?? '',
  };
}

export function PatientEditModal({
  open,
  patient,
  onClose,
  onSaved,
  section,
}: PatientEditModalProps) {
  const isLinked = Boolean(patient.shopify_customer_id);
  const [identity, setIdentity] = useState<DraftIdentity>(() => emptyIdentity(patient));
  const [clinical, setClinical] = useState<DraftClinical>(() => emptyClinical(patient));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<string | null>(null);
  // Scroll the error banner into view when it appears so the
  // receptionist can't miss a save failure even if they were focused
  // on a field at the bottom of the form.
  const errorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [error]);
  const showProfile = section === 'profile';
  const showCare = section === 'care';

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  const handleSave = async () => {
    // Validation only kicks in for the section the user can see
    // — name is required on the profile section, never on care.
    if (showProfile) {
      if (!identity.firstName.trim() || !identity.lastName.trim()) {
        setError('First name and last name are required.');
        return;
      }
      if (identity.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email.trim())) {
        setError('That email does not look right.');
        return;
      }
    }
    setError(null);
    setErrorKind(null);
    setSaving(true);
    try {
      // Country isn't surfaced in the form anymore (Shopify sync
      // handles it); preserve the existing value rather than
      // clearing it on save. Address sends as a unit only if at
      // least one sub-field has a value.
      const hasAddress = Boolean(
        identity.addressLine1 || identity.addressLine2 || identity.city || identity.postcode,
      );
      const identityPayload = showProfile
        ? {
            firstName: identity.firstName.trim() || null,
            lastName: identity.lastName.trim() || null,
            email: identity.email.trim() || null,
            phone: identity.phone.trim() || null,
            address: hasAddress
              ? {
                  address1: identity.addressLine1.trim() || null,
                  address2: identity.addressLine2.trim() || null,
                  city: identity.city.trim() || null,
                  postcode: identity.postcode.trim() || null,
                  // Country is read-only on the profile and not
                  // shown on the form — pass through whatever the
                  // patient row already has so the staff edit
                  // doesn't accidentally null it out.
                  countryCode: patient.portal_ship_country_code ?? null,
                }
              : null,
          }
        : undefined;

      // DoB + Sex live on the Hero card now, so the Profile
      // pencil writes them as a narrow clinical payload. The Care
      // pencil writes the kin + notes fields. Communication
      // preferences was dropped from the UI; the column stays in
      // the schema but neither section sends it, so existing
      // values are preserved untouched.
      const clinicalPayload = showProfile
        ? {
            date_of_birth: clinical.dateOfBirth || null,
            sex: clinical.sex.trim() || null,
          }
        : showCare
          ? {
              allergies: clinical.allergies.trim() || null,
              emergency_contact_name: clinical.emergencyContactName.trim() || null,
              emergency_contact_phone: clinical.emergencyContactPhone.trim() || null,
              notes: clinical.notes.trim() || null,
            }
          : undefined;

      await staffUpdatePatient({
        patientId: patient.id,
        identity: identityPayload,
        clinical: clinicalPayload,
      });
      await onSaved();
      onClose();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Could not save changes. Try again.';
      const kind = (e as { errorKind?: string } | null)?.errorKind ?? null;
      setError(message);
      setErrorKind(kind);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={showProfile ? 'Edit profile' : 'Edit care details'}
      width={640}
      dismissable={!saving}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[3] }}>
          <Button variant="secondary" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            {isLinked ? 'Save and update online account' : 'Save changes'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        {/* Both Profile and Care edits flow through to the linked
            venneir.com / One Click account when one exists, so
            the warning surfaces on either section. The button
            copy in the footer above mirrors the same condition. */}
        {isLinked ? <LinkedAccountWarning /> : null}

        {showProfile ? (
          <>
            <SectionHeader title="Identity" subtitle={isLinked ? 'Synced to venneir.com and One Click' : 'Stored at the lab only'} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[4] }}>
              <Input
                label="First name"
                value={identity.firstName}
                onChange={(e) => setIdentity((s) => ({ ...s, firstName: e.target.value }))}
              />
              <Input
                label="Last name"
                value={identity.lastName}
                onChange={(e) => setIdentity((s) => ({ ...s, lastName: e.target.value }))}
              />
              {/* DoB + Sex live on the Hero card alongside the
                  identity fields, so the profile pencil edits
                  them too. They're written as a narrow clinical
                  payload — see handleSave above. */}
              <Input
                label="Date of birth"
                type="date"
                value={clinical.dateOfBirth}
                onChange={(e) => setClinical((s) => ({ ...s, dateOfBirth: e.target.value }))}
              />
              <Input
                label="Sex"
                value={clinical.sex}
                onChange={(e) => setClinical((s) => ({ ...s, sex: e.target.value }))}
              />
              <Input
                label="Email"
                type="email"
                leadingIcon={<Mail size={16} />}
                value={identity.email}
                onChange={(e) => setIdentity((s) => ({ ...s, email: e.target.value }))}
              />
              <Input
                label="Phone"
                type="tel"
                value={identity.phone}
                onChange={(e) => setIdentity((s) => ({ ...s, phone: e.target.value }))}
              />
            </div>

            {/* Subtle hairline + breathing room separates Identity
                from Delivery address so the form reads as two
                distinct fieldsets rather than one long stack. */}
            <div
              aria-hidden
              style={{
                height: 1,
                background: theme.color.border,
                margin: `${theme.space[3]}px 0`,
              }}
            />
            <SectionHeader title="Delivery address" subtitle={isLinked ? 'Used for online orders too' : 'Stored at the lab only'} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
              <Input
                label="Address line 1"
                value={identity.addressLine1}
                onChange={(e) => setIdentity((s) => ({ ...s, addressLine1: e.target.value }))}
              />
              <Input
                label="Address line 2"
                value={identity.addressLine2}
                onChange={(e) => setIdentity((s) => ({ ...s, addressLine2: e.target.value }))}
              />
              {/* Country has been dropped from the staff edit form
                  — Shopify sync handles it and surfacing the field
                  here just invites accidental edits. The patient
                  row's existing country code is preserved on save. */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[4] }}>
                <Input
                  label="City"
                  value={identity.city}
                  onChange={(e) => setIdentity((s) => ({ ...s, city: e.target.value }))}
                />
                <Input
                  label="Postcode"
                  value={identity.postcode}
                  onChange={(e) => setIdentity((s) => ({ ...s, postcode: e.target.value }))}
                />
              </div>
            </div>
          </>
        ) : null}

        {showCare ? (
          <>
            <SectionHeader
              title="Care details"
              subtitle={isLinked ? 'Synced to venneir.com and One Click' : 'Stored at the lab only'}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[4] }}>
              <Input
                label="Emergency contact name"
                value={clinical.emergencyContactName}
                onChange={(e) => setClinical((s) => ({ ...s, emergencyContactName: e.target.value }))}
              />
              <Input
                label="Emergency contact phone"
                type="tel"
                value={clinical.emergencyContactPhone}
                onChange={(e) => setClinical((s) => ({ ...s, emergencyContactPhone: e.target.value }))}
              />
            </div>

            <Input
              label="Allergies and sensitivities"
              value={clinical.allergies}
              onChange={(e) => setClinical((s) => ({ ...s, allergies: e.target.value }))}
            />

            <Input
              label="Permanent notes"
              value={clinical.notes}
              onChange={(e) => setClinical((s) => ({ ...s, notes: e.target.value }))}
            />
          </>
        ) : null}

        {error ? (
          <div
            ref={errorRef}
            role="alert"
            style={{
              display: 'flex',
              gap: theme.space[3],
              padding: theme.space[4],
              borderRadius: theme.radius.input,
              background: theme.color.alert,
              color: theme.color.surface,
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.medium,
              lineHeight: 1.5,
              boxShadow: theme.shadow.card,
            }}
          >
            <AlertTriangle size={20} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: theme.type.weight.semibold }}>
                Save failed
              </p>
              <p style={{ margin: `${theme.space[1]}px 0 0` }}>{error}</p>
              {errorKind ? (
                <p
                  style={{
                    margin: `${theme.space[2]}px 0 0`,
                    fontSize: theme.type.size.xs,
                    opacity: 0.8,
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  }}
                >
                  {errorKind}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function LinkedAccountWarning() {
  return (
    <div
      role="note"
      style={{
        display: 'flex',
        gap: theme.space[3],
        padding: theme.space[4],
        borderRadius: theme.radius.input,
        background: theme.color.accentBg,
        border: `1px solid ${theme.color.accent}`,
      }}
    >
      <AlertTriangle size={20} color={theme.color.accent} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
      <div>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.accent,
          }}
        >
          This patient is linked to their venneir.com &amp; One Click account.
        </p>
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            lineHeight: 1.5,
          }}
        >
          Saving will update the customer&apos;s name, email, phone and address on the
          venneir.com side too. They&apos;ll see the change in the One Click portal,
          on future orders, and on any marketing email Venneir sends. Only edit if
          you have the customer in front of you and they&apos;ve agreed to the change.
        </p>
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h3
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
        }}
      >
        {title}
      </h3>
      {subtitle ? (
        <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
