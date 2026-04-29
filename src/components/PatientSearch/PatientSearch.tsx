import { type ReactNode, useMemo, useState } from 'react';
import { Phone, Search, User, Mail } from 'lucide-react';
import { Input } from '../Input/Input.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { theme } from '../../theme/index.ts';
import {
  type PatientRow,
  type ShopifyCustomerResult,
  usePatientSearch,
  useShopifyCustomerSearch,
  registerShopifyCustomerAsPatient,
  patientFullName,
  getPatient,
} from '../../lib/queries/patients.ts';

export interface PatientSearchProps {
  onPick: (patient: PatientRow) => void;
  onCreateNew?: (term: string) => void;
  emptyHint?: ReactNode;
  autoFocus?: boolean;
  placeholder?: string;
  // When true, the search also queries Shopify customers and surfaces
  // those who have no patient row yet, with a register-as-patient
  // affordance. requires registerLocationId.
  enableShopifyLookup?: boolean;
  registerLocationId?: string;
}

export function PatientSearch({
  onPick,
  onCreateNew,
  emptyHint,
  autoFocus = true,
  placeholder = 'Phone, name, or email',
  enableShopifyLookup = false,
  registerLocationId,
}: PatientSearchProps) {
  const [term, setTerm] = useState('');
  const { data, loading } = usePatientSearch(term);
  const shopify = useShopifyCustomerSearch(term, { enabled: enableShopifyLookup });
  const trimmed = term.trim();

  // Dedup Shopify-only hits against local patients so we never show
  // a Shopify row that already has a corresponding patient. Match on
  // shopify_customer_id first, then on lowercase email.
  const shopifyOnly = useMemo<ShopifyCustomerResult[]>(() => {
    if (!enableShopifyLookup) return [];
    const knownIds = new Set(
      data
        .map((p) => (p.shopify_customer_id ? String(p.shopify_customer_id) : null))
        .filter((s): s is string => !!s),
    );
    const knownEmails = new Set(
      data.map((p) => (p.email ?? '').trim().toLowerCase()).filter(Boolean),
    );
    return shopify.data.filter((c) => {
      if (c.shopify_customer_id && knownIds.has(String(c.shopify_customer_id))) return false;
      const email = (c.email ?? '').trim().toLowerCase();
      if (email && knownEmails.has(email)) return false;
      return true;
    });
  }, [data, shopify.data, enableShopifyLookup]);

  // Create-new is always offered once the user has typed enough to
  // commit to a search term. It sits below any matches so the
  // receptionist can pick "this is a new patient" even when the
  // search is already showing similar names.
  const showCreate = trimmed.length >= 2 && Boolean(onCreateNew);
  const hasNoMatches =
    trimmed.length >= 2 &&
    !loading &&
    !shopify.loading &&
    data.length === 0 &&
    shopifyOnly.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <Input
        autoFocus={autoFocus}
        placeholder={placeholder}
        leadingIcon={<Search size={20} />}
        value={term}
        inputMode="search"
        onChange={(e) => setTerm(e.target.value)}
      />

      {trimmed.length < 2 ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkSubtle }}>
          {emptyHint ?? 'Type at least two characters. We will search existing patients and venneir.com customers.'}
        </p>
      ) : (
        <>
          {/* Local patients (existing rows). */}
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              <Skeleton height={88} radius={12} />
              <Skeleton height={88} radius={12} />
              <Skeleton height={88} radius={12} />
            </div>
          ) : data.length > 0 ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {data.map((p) => (
                <li key={p.id}>
                  <PatientResultRow patient={p} onPick={onPick} />
                </li>
              ))}
            </ul>
          ) : null}

          {/* Shopify customers with no patient row yet, only when the
              caller opted in to the Shopify lookup. */}
          {enableShopifyLookup && (shopify.loading || shopifyOnly.length > 0) && (
            <ShopifyResultsBlock
              loading={shopify.loading}
              results={shopifyOnly}
              registerLocationId={registerLocationId}
              onPick={onPick}
            />
          )}

          {hasNoMatches ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              No match for &ldquo;{trimmed}&rdquo;. Create them as a new patient below.
            </p>
          ) : null}
        </>
      )}

      {showCreate ? (
        <button
          type="button"
          onClick={() => onCreateNew?.(trimmed)}
          style={{
            appearance: 'none',
            border: `1px dashed ${theme.color.border}`,
            background: 'transparent',
            borderRadius: 12,
            padding: `${theme.space[4]}px ${theme.space[4]}px`,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[3],
            color: theme.color.ink,
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            cursor: 'pointer',
            textAlign: 'left',
            marginTop: theme.space[1],
          }}
        >
          <User size={20} />
          <span style={{ flex: 1 }}>
            {hasNoMatches ? (
              <>Create new patient for &ldquo;<strong>{trimmed}</strong>&rdquo;</>
            ) : (
              <>
                Not the right person?{' '}
                <strong>Create new patient for &ldquo;{trimmed}&rdquo;</strong>
              </>
            )}
          </span>
        </button>
      ) : null}
    </div>
  );
}

function ShopifyResultsBlock({
  loading,
  results,
  registerLocationId,
  onPick,
}: {
  loading: boolean;
  results: ShopifyCustomerResult[];
  registerLocationId: string | undefined;
  onPick: (patient: PatientRow) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
          marginTop: theme.space[2],
        }}
      >
        <img
          src="/one-click-logo-icon.png"
          alt=""
          aria-hidden
          width={14}
          height={14}
          style={{ display: 'block', flexShrink: 0 }}
        />
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.wide,
            textTransform: 'uppercase',
          }}
        >
          From venneir.com (not yet a patient)
        </p>
      </div>
      {loading && results.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <Skeleton height={56} radius={12} />
          <Skeleton height={56} radius={12} />
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {results.map((c) => (
            <li key={c.shopify_customer_id}>
              <ShopifyResultRow
                customer={c}
                registerLocationId={registerLocationId}
                onPick={onPick}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ShopifyResultRow({
  customer,
  registerLocationId,
  onPick,
}: {
  customer: ShopifyCustomerResult;
  registerLocationId: string | undefined;
  onPick: (patient: PatientRow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || 'Unnamed';

  const handleClick = async () => {
    if (!registerLocationId) {
      setError('No location set. Reload and try again.');
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { patientId } = await registerShopifyCustomerAsPatient({
        shopifyCustomerId: customer.shopify_customer_id,
        locationId: registerLocationId,
      });
      const patient = await getPatient(patientId);
      if (!patient) throw new Error('Could not load the new patient row.');
      onPick(patient);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not register');
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      style={{
        appearance: 'none',
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        borderRadius: 12,
        padding: theme.space[3],
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        width: '100%',
        textAlign: 'left',
        cursor: busy ? 'wait' : 'pointer',
        fontFamily: 'inherit',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          fontWeight: theme.type.weight.semibold,
          fontSize: theme.type.size.sm,
        }}
      >
        {(customer.first_name?.[0] ?? '').toUpperCase()}
        {(customer.last_name?.[0] ?? '').toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontSize: theme.type.size.base,
          }}
        >
          {fullName}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
            flexWrap: 'wrap',
          }}
        >
          {customer.email ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Mail size={12} /> {customer.email}
            </span>
          ) : null}
          {customer.phone ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Phone size={12} /> {customer.phone}
            </span>
          ) : null}
          <span style={{ color: theme.color.inkSubtle }}>
            {customer.orders_count} {customer.orders_count === 1 ? 'order' : 'orders'}
          </span>
        </p>
        {error ? (
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.alert }}>
            {error}
          </p>
        ) : null}
      </div>
      <span
        style={{
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.accent,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {busy ? 'Registering' : 'Register & continue'}
      </span>
    </button>
  );
}

function PatientResultRow({ patient, onPick }: { patient: PatientRow; onPick: (p: PatientRow) => void }) {
  const hasContact = Boolean(patient.phone || patient.email);
  return (
    <button
      type="button"
      onClick={() => onPick(patient)}
      style={{
        appearance: 'none',
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        borderRadius: 12,
        padding: theme.space[4],
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[4],
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          fontWeight: theme.type.weight.semibold,
          fontSize: theme.type.size.sm,
        }}
      >
        {(patient.first_name?.[0] || '').toUpperCase()}
        {(patient.last_name?.[0] || '').toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.space[3],
          }}
        >
          <p
            style={{
              margin: 0,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              fontSize: theme.type.size.base,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {patientFullName(patient)}
          </p>
          <span
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkSubtle,
              fontWeight: theme.type.weight.medium,
              letterSpacing: theme.type.tracking.wide,
              flexShrink: 0,
            }}
          >
            {patient.internal_ref}
          </span>
        </div>

        {hasContact ? (
          <div
            style={{
              marginTop: theme.space[3],
              paddingTop: theme.space[3],
              borderTop: `1px solid ${theme.color.border}`,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[2],
            }}
          >
            {patient.phone ? <ContactLine icon={<Phone size={14} />} value={patient.phone} /> : null}
            {patient.email ? <ContactLine icon={<Mail size={14} />} value={patient.email} /> : null}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function ContactLine({ icon, value }: { icon: ReactNode; value: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
        minWidth: 0,
      }}
    >
      <span style={{ color: theme.color.inkSubtle, display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </span>
  );
}
