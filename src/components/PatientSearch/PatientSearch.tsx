import { type ReactNode, useMemo, useState } from 'react';
import { Info, Phone, Search, User, Users, Mail, ShoppingBag } from 'lucide-react';
import { Input } from '../Input/Input.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { Tooltip } from '../Tooltip/Tooltip.tsx';
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

// Hash a stable identifier (email preferred, id as fallback) into a
// theme.avatar palette entry so people with similar names get visually
// distinct circles. djb2-style integer hash; pure function so it is
// deterministic across renders and trivially unit-testable.
function getAvatarPalette(seed: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const palette = theme.avatar;
  // palette is a non-empty const tuple, so `n % palette.length` is always a valid index.
  return palette[Math.abs(hash) % palette.length]!;
}

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
          {/* Local patients (existing rows). The section header mirrors
              the venneir.com one structurally (icon + sentence-case
              h3) so the two groups read as siblings. Without this,
              the list reads as one undifferentiated wall. */}
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              <Skeleton height={88} radius={12} />
              <Skeleton height={88} radius={12} />
              <Skeleton height={88} radius={12} />
            </div>
          ) : data.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2], marginTop: theme.space[3] }}>
              <SearchSectionHeading
                icon={<Users size={18} aria-hidden style={{ color: theme.color.ink }} />}
                title="Existing patients on Lounge"
              />
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                {data.map((p) => (
                  <li key={p.id}>
                    <PatientResultRow patient={p} onPick={onPick} />
                  </li>
                ))}
              </ul>
            </div>
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

// Section heading for the search results — same chrome whether we're
// labelling existing patients or venneir.com customers, so the two
// groups read as siblings on the page. The optional `info` prop
// renders a small (i) trigger that opens a Tooltip; we use it only on
// the venneir.com section because that group needs context.
function SearchSectionHeading({
  icon,
  title,
  info,
}: {
  icon: ReactNode;
  title: string;
  info?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[2],
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      <h3
        style={{
          margin: 0,
          fontSize: theme.type.size.base,
          color: theme.color.ink,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.tight,
        }}
      >
        {title}
      </h3>
      {info ? (
        <Tooltip align="start" maxWidth={300} content={info}>
          <button
            type="button"
            aria-label={`More about: ${title}`}
            style={{
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              padding: theme.space[1],
              margin: `0 0 0 -${theme.space[1]}px`,
              borderRadius: theme.radius.pill,
              color: theme.color.inkSubtle,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 32,
              minHeight: 32,
            }}
          >
            <Info size={16} aria-hidden />
          </button>
        </Tooltip>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2], marginTop: theme.space[2] }}>
      <SearchSectionHeading
        icon={
          <img
            src="/one-click-logo-icon.png"
            alt=""
            aria-hidden
            width={18}
            height={18}
            style={{ display: 'block', flexShrink: 0 }}
          />
        }
        title="From venneir.com"
        info={
          <span>
            They've shopped on venneir.com but aren't yet registered as a
            patient on Lounge. Tap <strong>Register &amp; continue</strong> to
            add them. This is the standard first-visit flow for anyone
            arriving from the website, no special handling needed.
          </span>
        }
      />
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

  const showOrders = customer.orders_count > 0;
  const ordersLabel = customer.orders_count === 1 ? '1 order' : `${customer.orders_count} orders`;
  const hasMetadata = Boolean(customer.phone || customer.email || showOrders);
  const avatar = getAvatarPalette(customer.email ?? String(customer.shopify_customer_id));
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
        padding: theme.space[4],
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[4],
        width: '100%',
        textAlign: 'left',
        cursor: busy ? 'wait' : 'pointer',
        fontFamily: 'inherit',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: theme.radius.pill,
          background: avatar.bg,
          color: avatar.fg,
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
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.space[4],
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
              minWidth: 0,
            }}
          >
            {fullName}
          </p>
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.accent,
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {busy ? 'Registering' : 'Register & continue'}
          </span>
        </div>

        {hasMetadata ? (
          <div
            style={{
              marginTop: theme.space[2],
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[1],
            }}
          >
            {customer.phone ? <ContactLine icon={<Phone size={14} />} value={customer.phone} /> : null}
            {customer.email ? <ContactLine icon={<Mail size={14} />} value={customer.email} /> : null}
            {showOrders ? <ContactLine icon={<ShoppingBag size={14} />} value={ordersLabel} /> : null}
          </div>
        ) : null}

        {error ? (
          <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.alert }}>
            {error}
          </p>
        ) : null}
      </div>
    </button>
  );
}

function PatientResultRow({ patient, onPick }: { patient: PatientRow; onPick: (p: PatientRow) => void }) {
  const hasContact = Boolean(patient.phone || patient.email);
  const avatar = getAvatarPalette(patient.email ?? patient.id);
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
          background: avatar.bg,
          color: avatar.fg,
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
              marginTop: theme.space[2],
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[1],
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
