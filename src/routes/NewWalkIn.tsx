import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Footprints, Headset, MapPin, ShieldCheck } from 'lucide-react';
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
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';
import { useCurrentLocation } from '../lib/queries/locations.ts';
import { supabase } from '../lib/supabase.ts';

type Step = 'find' | 'create';

// What kind of identifier did the receptionist search for? Drives the
// auto-fill on the "create new patient" form so we don't drop an email
// into the First name box.
//
//   "alex@venneir.com"           -> email
//   "07700 900 000"              -> phone
//   "+44 7700 900000"            -> phone
//   "Alex Smith"                 -> name
//   "Alex"                       -> name
//
// Pure function, exported so it can be unit-tested.
export function classifySearchTerm(term: string): 'email' | 'phone' | 'name' {
  const trimmed = term.trim();
  // Email: anything containing an @. We don't validate the full RFC,
  // and a half-typed address like "alex@" still seeds the email
  // field (the alternative is dropping it into First name, which is
  // worse). Receptionist almost always types complete addresses.
  if (trimmed.includes('@')) return 'email';
  // Phone: 7–15 digits with only digit-friendly punctuation in between
  // (spaces, +, -, parentheses). Letters anywhere bumps it to a name.
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 15 && /^[\d\s+()\-]+$/.test(trimmed)) {
    return 'phone';
  }
  return 'name';
}

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
  const { account: currentAccount } = useCurrentAccount();
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

  // Customer-service staff don't register walk-ins — they answer
  // calls and tickets remotely. This route is reachable from the
  // bottom nav (they can't be told not to tap it), so explain in
  // plain English what walk-in is for, who uses it, and what THEY
  // should do instead. Reads top-to-bottom even for a brand-new
  // hire scanning quickly.
  const isCsOnly = currentAccount?.is_cs_only === true;
  if (isCsOnly) {
    return <WalkInCsExplainer isMobile={isMobile} />;
  }

  // Once a patient is picked or just-created, hand off to the arrival
  // wizard. Service / items / JB / customer details / consent / start
  // all live there; this page is now just the "who is this person?"
  // entry point.
  const onPick = (p: PatientRow) => {
    navigate(`/arrival/walk-in/${p.id}`);
  };

  const onCreateNew = (term: string) => {
    const trimmed = term.trim();
    const kind = classifySearchTerm(trimmed);
    if (kind === 'email') {
      setNewPatient((s) => ({ ...s, email: trimmed }));
    } else if (kind === 'phone') {
      setNewPatient((s) => ({ ...s, phone: trimmed }));
    } else {
      const parts = trimmed.split(/\s+/);
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

// WalkInCsExplainer — shown when a Customer Service operator opens
// the /walk-in/new route. CS staff don't register walk-ins; they
// help patients remotely by phone and ticket. The screen makes
// three things clear at a glance:
//
//   1. What "walk-in" actually means — a person physically walking
//      into the clinic off the street.
//   2. Who uses this button — in-clinic reception staff only.
//   3. What CS should do instead — point the patient at the public
//      booking page or transfer to the clinic.
//
// Designed to read for foreign / first-day-on-the-job staff: short
// sentences, plain English, one fact per row, three icons that
// carry meaning without colour.
function WalkInCsExplainer({ isMobile }: { isMobile: boolean }) {
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
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <TopBar variant="subpage" backTo="/schedule" />

        <div
          style={{
            background: theme.color.surface,
            borderRadius: theme.radius.card,
            padding: isMobile ? theme.space[6] : theme.space[8],
            boxShadow: theme.shadow.card,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: theme.space[5],
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 72,
              height: 72,
              borderRadius: theme.radius.pill,
              background: theme.color.accentBg,
              color: theme.color.accent,
            }}
          >
            <Footprints size={32} aria-hidden />
          </span>

          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <h1
              style={{
                margin: 0,
                fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
                fontWeight: theme.type.weight.semibold,
                letterSpacing: theme.type.tracking.tight,
                color: theme.color.ink,
                lineHeight: theme.type.leading.tight,
              }}
            >
              Walk-in is for the clinic team
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.base,
                color: theme.color.inkMuted,
                lineHeight: theme.type.leading.normal,
              }}
            >
              This is for receptionists registering someone who has just walked into the
              clinic off the street. Customer Service shouldn't use it.
            </p>
          </div>

          <div
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[3],
              textAlign: 'left',
            }}
          >
            <ExplainerRow
              icon={<MapPin size={18} aria-hidden />}
              title="Used in the clinic"
              body="Reception taps Walk-in when a patient is standing at the desk and has no appointment yet."
            />
            <ExplainerRow
              icon={<Headset size={18} aria-hidden />}
              title="You're remote support"
              body="Customer Service helps patients remotely. You're not the one greeting them at the desk."
            />
            <ExplainerRow
              icon={<ShieldCheck size={18} aria-hidden />}
              title="What to do instead"
              body="Point the patient to venneir.com to book, or pass it on to the clinic team if they need in-person help."
            />
          </div>
        </div>
      </div>
    </main>
  );
}

// One row inside the explainer card. Accent-tinted icon on the
// left, bold title + muted body on the right. Stays readable for
// staff who don't speak English as a first language — short
// sentences, no jargon, one fact per row.
function ExplainerRow({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: theme.color.bg,
        borderRadius: theme.radius.input,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.normal,
          }}
        >
          {body}
        </span>
      </div>
    </div>
  );
}

