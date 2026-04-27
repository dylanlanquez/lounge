import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Button, Card, Input, Toast } from '../components/index.ts';
import { PatientSearch } from '../components/PatientSearch/PatientSearch.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import {
  type PatientRow,
  patientFullName,
} from '../lib/queries/patients.ts';
import { useCurrentLocation } from '../lib/queries/locations.ts';
import { createWalkInVisit } from '../lib/queries/visits.ts';
import { supabase } from '../lib/supabase.ts';

type Step = 'find' | 'create' | 'service';

export function NewWalkIn() {
  const { user, loading: authLoading } = useAuth();
  const { data: location } = useCurrentLocation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('find');
  const [patient, setPatient] = useState<PatientRow | null>(null);
  const [newPatient, setNewPatient] = useState({
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
  });
  const [seedTerm, setSeedTerm] = useState('');
  const [serviceType, setServiceType] = useState<string>('denture_repair');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const onPick = (p: PatientRow) => {
    setPatient(p);
    setStep('service');
  };

  const onCreateNew = (term: string) => {
    // Heuristic: if term is mostly digits, treat as phone. Otherwise split as name.
    const digitsOnly = term.replace(/\D/g, '');
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      setNewPatient((s) => ({ ...s, phone: term }));
    } else {
      const parts = term.split(/\s+/);
      setNewPatient((s) => ({
        ...s,
        first_name: parts[0] ?? '',
        last_name: parts.slice(1).join(' '),
      }));
    }
    setSeedTerm(term);
    setStep('create');
  };

  const submitNewPatient = async (e: FormEvent) => {
    e.preventDefault();
    if (!location) return;
    if (!newPatient.first_name || !newPatient.last_name) {
      setError('First name and last name are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // patients.account_id is a legacy NOT NULL column. Resolve from the
      // signed-in user via auth_account_id() RPC.
      const { data: accountId, error: accErr } = await supabase.rpc('auth_account_id');
      if (accErr || !accountId) {
        throw new Error(
          accErr?.message ??
            'Could not resolve your account. Make sure your accounts row is set up in Meridian.'
        );
      }
      const { data, error: err } = await supabase
        .from('patients')
        .insert({
          account_id: accountId,
          location_id: location.id,
          first_name: newPatient.first_name.trim(),
          last_name: newPatient.last_name.trim(),
          email: newPatient.email.trim() || null,
          phone: newPatient.phone.trim() || null,
        })
        .select('*')
        .single();
      if (err || !data) throw new Error(err?.message ?? 'Could not create patient');
      setPatient(data as PatientRow);
      setStep('service');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  const submitVisit = async () => {
    if (!patient || !location) return;
    setSubmitting(true);
    setError(null);
    try {
      const { visit_id } = await createWalkInVisit({
        patient_id: patient.id,
        location_id: location.id,
        service_type: serviceType,
      });
      navigate(`/visit/${visit_id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setSubmitting(false);
    }
  };

  return (
    <main style={{ minHeight: '100dvh', background: theme.color.bg, padding: theme.space[6] }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[5] }}>
          <Button variant="tertiary" size="sm" onClick={() => navigate(-1)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <ArrowLeft size={16} /> Today
            </span>
          </Button>
        </header>

        <h1
          style={{
            margin: 0,
            fontSize: theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            marginBottom: theme.space[2],
          }}
        >
          New walk-in
        </h1>
        <p style={{ margin: 0, color: theme.color.inkMuted, marginBottom: theme.space[6] }}>
          {step === 'find' && 'Search for the patient first. Phone is fastest.'}
          {step === 'create' && 'Quick details. Anything not given can be filled in later.'}
          {step === 'service' && (
            <>
              <strong>{patient && patientFullName(patient)}</strong> — confirm service and arrive.
            </>
          )}
        </p>

        <Card padding="lg">
          {step === 'find' ? (
            <PatientSearch onPick={onPick} onCreateNew={onCreateNew} />
          ) : step === 'create' ? (
            <form onSubmit={submitNewPatient} style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
              <Input
                label="First name"
                required
                autoFocus={!newPatient.first_name}
                value={newPatient.first_name}
                onChange={(e) => setNewPatient({ ...newPatient, first_name: e.target.value })}
              />
              <Input
                label="Last name"
                required
                value={newPatient.last_name}
                onChange={(e) => setNewPatient({ ...newPatient, last_name: e.target.value })}
              />
              <Input
                label="Phone"
                type="tel"
                value={newPatient.phone}
                onChange={(e) => setNewPatient({ ...newPatient, phone: e.target.value })}
              />
              <Input
                label="Email"
                type="email"
                value={newPatient.email}
                onChange={(e) => setNewPatient({ ...newPatient, email: e.target.value })}
              />
              <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'space-between' }}>
                <Button type="button" variant="tertiary" onClick={() => setStep('find')}>
                  Back to search
                </Button>
                <Button type="submit" variant="primary" loading={submitting} showArrow>
                  Continue
                </Button>
              </div>
              {seedTerm ? (
                <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
                  Seeded from your search for &ldquo;{seedTerm}&rdquo;.
                </p>
              ) : null}
            </form>
          ) : (
            <ServiceStep
              serviceType={serviceType}
              onChange={setServiceType}
              onBack={() => setStep('find')}
              onSubmit={submitVisit}
              submitting={submitting}
            />
          )}
        </Card>

        {error ? (
          <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
            <Toast tone="error" title="Could not save" description={error} duration={6000} onDismiss={() => setError(null)} />
          </div>
        ) : null}
      </div>
    </main>
  );
}

function ServiceStep({
  serviceType,
  onChange,
  onBack,
  onSubmit,
  submitting,
}: {
  serviceType: string;
  onChange: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const options: { id: string; label: string }[] = [
    { id: 'denture_repair', label: 'Denture repair' },
    { id: 'same_day_appliance', label: 'Same-day appliance' },
    { id: 'click_in_veneers', label: 'Click-in veneers' },
    { id: 'other', label: 'Other / consultation' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <label style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium }}>
          Service type
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[2] }}>
          {options.map((o) => {
            const selected = serviceType === o.id;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onChange(o.id)}
                style={{
                  appearance: 'none',
                  border: `1px solid ${selected ? theme.color.ink : theme.color.border}`,
                  background: selected ? theme.color.ink : theme.color.surface,
                  color: selected ? theme.color.surface : theme.color.ink,
                  borderRadius: 12,
                  padding: `${theme.space[3]}px ${theme.space[3]}px`,
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.medium,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'space-between' }}>
        <Button type="button" variant="tertiary" onClick={onBack}>
          Back
        </Button>
        <Button type="button" variant="primary" onClick={onSubmit} loading={submitting} disabled={submitting}>
          Mark arrived <ChevronRight size={18} />
        </Button>
      </div>
    </div>
  );
}
