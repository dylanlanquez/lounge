import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Card, Input, Toast } from '../components/index.ts';
import { PatientSearch } from '../components/PatientSearch/PatientSearch.tsx';
import { TopBar } from '../components/TopBar/TopBar.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  type PatientRow,
} from '../lib/queries/patients.ts';
import { useCurrentLocation } from '../lib/queries/locations.ts';
import { supabase } from '../lib/supabase.ts';

type Step = 'find' | 'create';

function humanizePatientSaveError(err: { message?: string; code?: string } | null | undefined): string {
  const msg = err?.message ?? '';
  const code = err?.code;
  if (code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
    if (/email/i.test(msg)) {
      return 'A patient with this email is already on file at this location. Use the search to find them.';
    }
    if (/phone/i.test(msg)) {
      return 'A patient with this phone number is already on file at this location. Use the search to find them.';
    }
    return 'This person is already on file at this location. Use the search to find them.';
  }
  return msg || 'Could not create patient.';
}

export function NewWalkIn() {
  const { user, loading: authLoading } = useAuth();
  const { data: location } = useCurrentLocation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('find');
  const [newPatient, setNewPatient] = useState({
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
  });
  const [seedTerm, setSeedTerm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobile(640);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  // Once a patient is picked or just-created, hand off to the arrival
  // wizard. Service / items / JB / customer details / consent / start
  // all live there; this page is now just the "who is this person?"
  // entry point.
  const onPick = (p: PatientRow) => {
    navigate(`/arrival/walk-in/${p.id}`);
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
      if (err || !data) throw new Error(humanizePatientSaveError(err));
      navigate(`/arrival/walk-in/${(data as PatientRow).id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${isMobile ? theme.space[4] : theme.space[6]}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
        <TopBar variant="subpage" backTo="/schedule" />

        <h1
          style={{
            margin: 0,
            fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            marginBottom: theme.space[2],
          }}
        >
          New walk-in
        </h1>
        <p style={{ margin: 0, color: theme.color.inkMuted, marginBottom: theme.space[6] }}>
          {step === 'find'
            ? 'Search existing patients and venneir.com customers. If there is no match, create a new patient below the results.'
            : 'Quick details. Anything not given can be filled in later.'}
        </p>

        <Card padding="lg">
          {step === 'find' ? (
            <PatientSearch
              onPick={onPick}
              onCreateNew={onCreateNew}
              enableShopifyLookup={Boolean(location?.id)}
              registerLocationId={location?.id}
            />
          ) : (
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

