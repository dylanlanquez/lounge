import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Plus, ShoppingBag, UserPlus, UserRound } from 'lucide-react';
import {
  Avatar,
  BottomSheet,
  Button,
  Card,
  EmptyState,
  Input,
  Toast,
} from '../components/index.ts';
import { CartLineItem } from '../components/CartLineItem/CartLineItem.tsx';
import { CataloguePicker } from '../components/CataloguePicker/CataloguePicker.tsx';
import { PatientSearch } from '../components/PatientSearch/PatientSearch.tsx';
import { TopBar } from '../components/TopBar/TopBar.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { useCurrentLocation } from '../lib/queries/locations.ts';
import { catalogueLineTotalPence, formatPence } from '../lib/queries/carts.ts';
import {
  createPatient,
  patientFullName,
  type PatientRow,
} from '../lib/queries/patients.ts';
import { classifySearchTerm } from './NewWalkIn.tsx';
import { createQuickSaleSale, type QuickSaleLine } from '../lib/queries/quickSale.ts';

// Quick Sale — a focused, full-screen retail flow for selling products
// at the counter. The basket lives in client state until the operator
// taps "Take payment"; only then does createQuickSaleSale materialise a
// visit + cart and hand off to the existing Pay screen. See
// src/lib/queries/quickSale.ts for the architecture notes.

function capitalise(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// Human subtitle for a staged line: the picked options (arch, shade,
// upgrades) rendered the same way the cart line and arrival wizard
// render them, so the bag reads consistently across surfaces.
function lineSubtitle(line: QuickSaleLine): string | null {
  const parts = [
    line.options.arch ? capitalise(line.options.arch) : null,
    line.options.shade ? `Shade ${line.options.shade}` : null,
    ...(line.options.upgrades ?? []).map((u) => u.name),
  ].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function QuickSale() {
  const { user, loading: authLoading } = useAuth();
  const { data: location, loading: locationLoading } = useCurrentLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);

  const [lines, setLines] = useState<QuickSaleLine[]>([]);
  const [customer, setCustomer] = useState<PatientRow | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customerSheetOpen, setCustomerSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotalPence = useMemo(
    () =>
      lines.reduce(
        (sum, line) => sum + catalogueLineTotalPence(line.catalogue, line.qty, line.options),
        0,
      ),
    [lines],
  );

  // Catalogue ids already in the bag — drives the picker's "Suggested
  // for this booking" carousel (companions for what's already staged).
  const stagedCatalogueIds = useMemo(
    () => Array.from(new Set(lines.map((l) => l.catalogue.id))),
    [lines],
  );

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const incrementLine = (key: string) =>
    setLines((s) => s.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l)));
  const decrementLine = (key: string) =>
    setLines((s) =>
      s
        .map((l) => (l.key === key ? { ...l, qty: l.qty - 1 } : l))
        .filter((l) => l.qty > 0),
    );
  const removeLine = (key: string) => setLines((s) => s.filter((l) => l.key !== key));

  const onTakePayment = async () => {
    if (lines.length === 0 || !location) return;
    setSubmitting(true);
    setError(null);
    try {
      const { visitId } = await createQuickSaleSale({
        locationId: location.id,
        patientId: customer?.id ?? null,
        lines,
      });
      navigate(`/visit/${visitId}/pay`, { state: { from: 'quick_sale' } });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not start the sale.');
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

        <header style={{ marginBottom: theme.space[6] }}>
          <h1
            style={{
              margin: 0,
              fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            Quick sale
          </h1>
          <p
            style={{
              margin: `${theme.space[2]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.base,
              lineHeight: theme.type.leading.normal,
            }}
          >
            Sell products over the counter. Build the bag, then take payment.
          </p>
        </header>

        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <CustomerCard
            customer={customer}
            onAdd={() => setCustomerSheetOpen(true)}
            onRemove={() => setCustomer(null)}
          />

          {lines.length === 0 ? (
            <Card padding="none" elevation="raised">
              <EmptyState
                icon={<ShoppingBag size={26} />}
                title="The bag is empty"
                description="Add products to start the sale. You can attach a customer now or leave it as a walk-up sale."
                action={
                  <Button variant="primary" onClick={() => setPickerOpen(true)} showArrow>
                    Add products
                  </Button>
                }
                style={{ padding: `${theme.space[10]}px ${theme.space[6]}px` }}
              />
            </Card>
          ) : (
            <>
              <Card padding="lg" elevation="raised">
                <SectionHeader
                  title="Bag"
                  hint={`${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                  {lines.map((line) => (
                    <CartLineItem
                      key={line.key}
                      name={line.catalogue.name}
                      description={lineSubtitle(line)}
                      quantity={line.qty}
                      quantityEnabled={line.catalogue.quantity_enabled}
                      unitPricePence={catalogueLineTotalPence(line.catalogue, 1, line.options)}
                      lineTotalPence={catalogueLineTotalPence(line.catalogue, line.qty, line.options)}
                      thumbnailUrl={line.catalogue.image_url}
                      onIncrement={() => incrementLine(line.key)}
                      onDecrement={() => decrementLine(line.key)}
                      onRemove={() => removeLine(line.key)}
                    />
                  ))}
                </div>
                <div style={{ marginTop: theme.space[4] }}>
                  <Button variant="secondary" onClick={() => setPickerOpen(true)}>
                    <Plus size={18} />
                    Add more products
                  </Button>
                </div>
              </Card>

              <Card padding="lg" elevation="raised">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: theme.space[3],
                    marginBottom: theme.space[5],
                  }}
                >
                  <span
                    style={{
                      fontSize: theme.type.size.base,
                      fontWeight: theme.type.weight.medium,
                      color: theme.color.inkMuted,
                    }}
                  >
                    Total
                  </span>
                  <span
                    style={{
                      fontSize: theme.type.size.xl,
                      fontWeight: theme.type.weight.semibold,
                      color: theme.color.ink,
                      letterSpacing: theme.type.tracking.tight,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatPence(subtotalPence)}
                  </span>
                </div>
                <Button
                  variant="primary"
                  fullWidth
                  onClick={onTakePayment}
                  loading={submitting}
                  disabled={subtotalPence <= 0 || locationLoading || !location}
                  showArrow
                >
                  Take payment
                </Button>
              </Card>
            </>
          )}
        </div>
      </div>

      <CataloguePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        productsOnly
        cartCatalogueIds={stagedCatalogueIds}
        onStage={(cat, qty, opts) =>
          setLines((s) => [
            ...s,
            {
              key: `${cat.id}-${Date.now()}-${s.length}`,
              catalogue: cat,
              qty,
              options: opts,
            },
          ])
        }
        onItemAdded={() => {}}
      />

      <AddCustomerSheet
        open={customerSheetOpen}
        locationId={location?.id ?? null}
        onClose={() => setCustomerSheetOpen(false)}
        onAttach={(p) => {
          setCustomer(p);
          setCustomerSheetOpen(false);
        }}
      />

      {error ? (
        <div
          style={{
            position: 'fixed',
            bottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${theme.space[4]}px + env(safe-area-inset-bottom, 0px))`,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1100,
          }}
        >
          <Toast
            tone="error"
            title="Could not start the sale"
            description={error}
            duration={6000}
            onDismiss={() => setError(null)}
          />
        </div>
      ) : null}
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer affordance — optional attach. Anonymous by default (a
// walk-up sale rings up against the location's Counter Sale patient);
// staff can attach a real customer to put the purchase on their record.
// ─────────────────────────────────────────────────────────────────────────────

function CustomerCard({
  customer,
  onAdd,
  onRemove,
}: {
  customer: PatientRow | null;
  onAdd: () => void;
  onRemove: () => void;
}) {
  return (
    <Card padding="md" elevation="raised">
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        {customer ? (
          <Avatar name={patientFullName(customer)} size="md" />
        ) : (
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              borderRadius: theme.radius.pill,
              background: theme.color.accentBg,
              color: theme.color.accent,
              flexShrink: 0,
            }}
          >
            <UserRound size={22} />
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {customer ? patientFullName(customer) : 'Walk-up customer'}
          </p>
          <p style={{ margin: `2px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            {customer ? 'Sale will be saved to this record' : 'No account attached'}
          </p>
        </div>
        {customer ? (
          <Button variant="tertiary" size="sm" onClick={onRemove}>
            Remove
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={onAdd}>
            <UserPlus size={16} />
            Add customer
          </Button>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Add-customer sheet — find an existing patient or create a new one.
// Mirrors NewWalkIn's two-step find/create pattern, reusing PatientSearch
// and the shared createPatient helper so there is one way to make a
// patient across the app.
// ─────────────────────────────────────────────────────────────────────────────

function AddCustomerSheet({
  open,
  locationId,
  onClose,
  onAttach,
}: {
  open: boolean;
  locationId: string | null;
  onClose: () => void;
  onAttach: (patient: PatientRow) => void;
}) {
  const [step, setStep] = useState<'find' | 'create'>('find');
  const [form, setForm] = useState({ first_name: '', last_name: '', phone: '', email: '' });
  const [seedTerm, setSeedTerm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep('find');
    setForm({ first_name: '', last_name: '', phone: '', email: '' });
    setSeedTerm('');
    setError(null);
  };

  const onCreateNew = (term: string) => {
    const trimmed = term.trim();
    const kind = classifySearchTerm(trimmed);
    if (kind === 'email') {
      setForm((s) => ({ ...s, email: trimmed }));
    } else if (kind === 'phone') {
      setForm((s) => ({ ...s, phone: trimmed }));
    } else {
      const parts = trimmed.split(/\s+/);
      setForm((s) => ({ ...s, first_name: parts[0] ?? '', last_name: parts.slice(1).join(' ') }));
    }
    setSeedTerm(term);
    setStep('create');
  };

  const submitNew = async (e: FormEvent) => {
    e.preventDefault();
    if (!locationId) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createPatient({
        location_id: locationId,
        first_name: form.first_name,
        last_name: form.last_name,
        email: form.email,
        phone: form.phone,
      });
      reset();
      onAttach(created);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create customer.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add customer"
      description={
        step === 'find'
          ? 'Search existing patients and venneir.com customers, or create a new one.'
          : 'Quick details. Anything not given can be filled in later.'
      }
      onBack={step === 'create' ? () => setStep('find') : undefined}
    >
      {step === 'find' ? (
        <PatientSearch
          onPick={(p) => {
            reset();
            onAttach(p);
          }}
          onCreateNew={onCreateNew}
          enableShopifyLookup={Boolean(locationId)}
          registerLocationId={locationId ?? undefined}
        />
      ) : (
        <form onSubmit={submitNew} style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <Input
            label="First name"
            required
            autoFocus={!form.first_name}
            value={form.first_name}
            onChange={(e) => setForm({ ...form, first_name: e.target.value })}
          />
          <Input
            label="Last name"
            required
            value={form.last_name}
            onChange={(e) => setForm({ ...form, last_name: e.target.value })}
          />
          <Input
            label="Phone"
            type="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'space-between' }}>
            <Button type="button" variant="tertiary" onClick={() => setStep('find')}>
              Back to search
            </Button>
            <Button type="submit" variant="primary" loading={submitting} showArrow>
              Attach customer
            </Button>
          </div>
          {seedTerm ? (
            <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
              Seeded from your search for &ldquo;{seedTerm}&rdquo;.
            </p>
          ) : null}
        </form>
      )}

      {error ? (
        <div style={{ marginTop: theme.space[4] }}>
          <Toast tone="error" title="Could not add customer" description={error} duration={6000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </BottomSheet>
  );
}

// Small section header used inside the bag card.
function SectionHeader({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: theme.space[3],
        marginBottom: theme.space[4],
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.tight,
          color: theme.color.ink,
        }}
      >
        {title}
      </h2>
      <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted, fontVariantNumeric: 'tabular-nums' }}>
        {hint}
      </span>
    </div>
  );
}
