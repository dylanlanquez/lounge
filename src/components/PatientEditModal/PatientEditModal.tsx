import { useState } from 'react';
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

export interface PatientEditModalProps {
  open: boolean;
  patient: PatientEditModalPatient;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
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
  communicationPreferences: string;
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
    communicationPreferences: p.communication_preferences ?? '',
    notes: p.notes ?? '',
  };
}

export function PatientEditModal({ open, patient, onClose, onSaved }: PatientEditModalProps) {
  const isLinked = Boolean(patient.shopify_customer_id);
  const [identity, setIdentity] = useState<DraftIdentity>(() => emptyIdentity(patient));
  const [clinical, setClinical] = useState<DraftClinical>(() => emptyClinical(patient));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  const handleSave = async () => {
    if (!identity.firstName.trim() || !identity.lastName.trim()) {
      setError('First name and last name are required.');
      return;
    }
    if (identity.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email.trim())) {
      setError('That email does not look right.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // Build identity payload only with fields the user actually
      // touched. Empty strings still send — that's the form's way of
      // clearing a field. Address sends as a unit only if at least
      // one address sub-field has a value.
      const hasAddress = Boolean(
        identity.addressLine1 || identity.addressLine2 || identity.city || identity.postcode || identity.countryCode,
      );
      const identityPayload = {
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
              countryCode: identity.countryCode.trim().toUpperCase() || null,
            }
          : null,
      };

      const clinicalPayload = {
        date_of_birth: clinical.dateOfBirth || null,
        sex: clinical.sex.trim() || null,
        allergies: clinical.allergies.trim() || null,
        emergency_contact_name: clinical.emergencyContactName.trim() || null,
        emergency_contact_phone: clinical.emergencyContactPhone.trim() || null,
        communication_preferences: clinical.communicationPreferences.trim() || null,
        notes: clinical.notes.trim() || null,
      };

      await staffUpdatePatient({
        patientId: patient.id,
        identity: identityPayload,
        clinical: clinicalPayload,
      });
      await onSaved();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save changes. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Edit patient details"
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
        {isLinked ? <LinkedAccountWarning /> : null}

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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: theme.space[4] }}>
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
            <Input
              label="Country (ISO)"
              value={identity.countryCode}
              maxLength={2}
              onChange={(e) => setIdentity((s) => ({ ...s, countryCode: e.target.value.toUpperCase() }))}
            />
          </div>
        </div>

        <SectionHeader title="Clinical notes" subtitle="Stored at the lab. Not shared with the customer's online account." />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[4] }}>
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
            label="Allergies and sensitivities"
            value={clinical.allergies}
            onChange={(e) => setClinical((s) => ({ ...s, allergies: e.target.value }))}
          />
          <Input
            label="Communication preferences"
            value={clinical.communicationPreferences}
            onChange={(e) => setClinical((s) => ({ ...s, communicationPreferences: e.target.value }))}
          />
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
          label="Permanent notes"
          value={clinical.notes}
          onChange={(e) => setClinical((s) => ({ ...s, notes: e.target.value }))}
        />

        {error ? (
          <div
            role="alert"
            style={{
              padding: theme.space[3],
              borderRadius: theme.radius.input,
              background: 'rgba(184, 58, 42, 0.08)',
              border: `1px solid rgba(184, 58, 42, 0.2)`,
              color: theme.color.alert,
              fontSize: theme.type.size.sm,
            }}
          >
            {error}
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
