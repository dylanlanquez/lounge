import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';
import { ClinicianHoursSheet } from './Admin.tsx';

// A virtual impression clinician editing their OWN availability. Reached
// from the profile menu when an admin has turned on self-edit for them.
// Writes go through the lng_*_own_clinician_* RPCs (no admin access).
export function MyAvailability() {
  const navigate = useNavigate();
  const { account } = useCurrentAccount();
  const [error, setError] = useState<string | null>(null);

  const staffMemberId = account?.staff_member_id ?? null;
  const canSelfEdit =
    !!staffMemberId &&
    account?.is_virtual_impression_clinician === true &&
    account?.clinician_can_edit_own_hours === true;

  if (!canSelfEdit || !staffMemberId) {
    return (
      <main
        style={{
          maxWidth: 520,
          margin: '0 auto',
          padding: `${theme.space[16]}px ${theme.space[5]}px`,
          textAlign: 'center',
        }}
      >
        <h1 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
          Availability editing isn't on for you
        </h1>
        <p style={{ margin: `${theme.space[3]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, lineHeight: 1.5 }}>
          Ask an admin to turn on self-edit for your clinician account in Admin, Virtual impressions.
        </p>
        <Button variant="secondary" onClick={() => navigate('/schedule')}>
          Back to schedule
        </Button>
      </main>
    );
  }

  return (
    <>
      <ClinicianHoursSheet
        staff={{ staff_member_id: staffMemberId, display_name: account?.display_name ?? 'My availability' }}
        selfEdit
        onClose={() => navigate('/schedule')}
        onError={(msg) => setError(msg)}
      />
      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 1200 }}>
          <Toast tone="error" title={error} duration={5000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </>
  );
}
