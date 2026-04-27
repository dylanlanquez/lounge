import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plus, ShoppingCart } from 'lucide-react';
import { Button, Card, EmptyState, Input, StatusPill, Toast } from '../components/index.ts';
import { CartLineItem } from '../components/CartLineItem/CartLineItem.tsx';
import { TopBar } from '../components/TopBar/TopBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { useVisitDetail } from '../lib/queries/visits.ts';
import { patientFullName } from '../lib/queries/patients.ts';
import {
  addCartItem,
  formatPence,
  removeCartItem,
  updateCartItemQuantity,
  useCart,
} from '../lib/queries/carts.ts';

export function VisitDetail() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { visit, patient, loading } = useVisitDetail(id);
  const { cart, items, loading: cartLoading, refresh, ensureOpen } = useCart(id);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', price: '' });
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const subtotal = items.reduce((sum, i) => sum + i.line_total_pence, 0);
  const discount = items.reduce((sum, i) => sum + i.discount_pence, 0);
  const total = subtotal - discount;
  const cartLocked = cart?.status === 'paid' || cart?.status === 'voided';

  const onAddItem = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const priceFloat = Number(draft.price.replace(/[^\d.]/g, ''));
    const pence = Math.round(priceFloat * 100);
    if (!draft.name.trim() || !Number.isFinite(pence) || pence < 0) {
      setError('Name and price required.');
      return;
    }
    setBusyItem('add');
    try {
      const opened = await ensureOpen();
      if (!opened) throw new Error('Could not open cart');
      await addCartItem(opened.id, { name: draft.name.trim(), unit_price_pence: pence });
      setDraft({ name: '', price: '' });
      setAdding(false);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusyItem(null);
    }
  };

  const inc = async (id: string, q: number) => {
    setBusyItem(id);
    try {
      await updateCartItemQuantity(id, q + 1);
      refresh();
    } finally {
      setBusyItem(null);
    }
  };
  const dec = async (id: string, q: number) => {
    setBusyItem(id);
    try {
      await updateCartItemQuantity(id, q - 1);
      refresh();
    } finally {
      setBusyItem(null);
    }
  };
  const rm = async (id: string) => {
    setBusyItem(id);
    try {
      await removeCartItem(id);
      refresh();
    } finally {
      setBusyItem(null);
    }
  };

  const isMobile = useIsMobile(640);
  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <TopBar variant="subpage" backTo="/schedule" />

        {loading ? (
          <p style={{ color: theme.color.inkMuted }}>Loading visit…</p>
        ) : !visit ? (
          <EmptyState title="Visit not found" description="That visit no longer exists or you do not have access." />
        ) : (
          <>
            <div style={{ marginBottom: theme.space[6] }}>
              <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                {visit.arrival_type === 'walk_in' ? 'Walk-in' : 'Scheduled'} · opened{' '}
                {new Date(visit.opened_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </p>
              <h1
                style={{
                  margin: `${theme.space[1]}px 0 ${theme.space[2]}px`,
                  fontSize: theme.type.size.xxl,
                  fontWeight: theme.type.weight.semibold,
                  letterSpacing: theme.type.tracking.tight,
                }}
              >
                {patient ? patientFullName(patient) : 'Patient'}
              </h1>
              <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
                {patient?.lwo_ref ? <StatusPill tone="arrived" size="sm">{patient.lwo_ref}</StatusPill> : null}
                {patient?.internal_ref ? <StatusPill tone="neutral" size="sm">{patient.internal_ref}</StatusPill> : null}
                <StatusPill tone={visit.status === 'opened' ? 'in_progress' : 'neutral'} size="sm">
                  {visit.status}
                </StatusPill>
                {cart ? (
                  <StatusPill tone={cart.status === 'paid' ? 'arrived' : cart.status === 'open' ? 'neutral' : 'no_show'} size="sm">
                    Cart: {cart.status}
                  </StatusPill>
                ) : null}
              </div>
            </div>

            <Card padding="lg">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: theme.space[4] }}>
                <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
                  Cart
                </h2>
                {!adding && !cartLocked ? (
                  <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                      <Plus size={16} /> Add item
                    </span>
                  </Button>
                ) : null}
              </div>

              {cartLoading ? (
                <p style={{ color: theme.color.inkMuted }}>Loading cart…</p>
              ) : items.length === 0 && !adding ? (
                <EmptyState
                  icon={<ShoppingCart size={20} />}
                  title="No items yet"
                  description="Add a custom line item, or wait for the catalogue picker that ships in a future round."
                  action={
                    <Button variant="primary" onClick={() => setAdding(true)} disabled={cartLocked}>
                      Add item
                    </Button>
                  }
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                  {items.map((it) => (
                    <CartLineItem
                      key={it.id}
                      name={it.name}
                      description={it.description}
                      quantity={it.quantity}
                      unitPricePence={it.unit_price_pence}
                      lineTotalPence={it.line_total_pence}
                      onIncrement={() => inc(it.id, it.quantity)}
                      onDecrement={() => dec(it.id, it.quantity)}
                      onRemove={() => rm(it.id)}
                      disabled={busyItem === it.id || cartLocked}
                    />
                  ))}
                </div>
              )}

              {adding ? (
                <form
                  onSubmit={onAddItem}
                  style={{
                    marginTop: theme.space[4],
                    padding: theme.space[4],
                    background: theme.color.bg,
                    borderRadius: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: theme.space[3],
                  }}
                >
                  <Input
                    label="Item name"
                    autoFocus
                    placeholder="Consultation, Whitening top-up, etc."
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                  <Input
                    label="Unit price (£)"
                    inputMode="decimal"
                    placeholder="45.00"
                    value={draft.price}
                    onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                  />
                  <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
                    <Button
                      type="button"
                      variant="tertiary"
                      onClick={() => {
                        setAdding(false);
                        setDraft({ name: '', price: '' });
                      }}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" variant="primary" loading={busyItem === 'add'}>
                      Add to cart
                    </Button>
                  </div>
                </form>
              ) : null}

              {items.length > 0 ? (
                <Totals subtotal={subtotal} discount={discount} total={total} />
              ) : null}
            </Card>

            {items.length > 0 ? (
              <div style={{ marginTop: theme.space[6], display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
                <Button
                  variant="primary"
                  size="lg"
                  showArrow
                  disabled={cartLocked}
                  onClick={() => navigate(`/visit/${visit.id}/pay`)}
                >
                  Take payment {formatPence(total)}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not save" description={error} duration={6000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </main>
  );
}

function Totals({ subtotal, discount, total }: { subtotal: number; discount: number; total: number }) {
  return (
    <div
      style={{
        marginTop: theme.space[6],
        paddingTop: theme.space[5],
        borderTop: `1px solid ${theme.color.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      <Row label="Subtotal" value={formatPence(subtotal)} />
      {discount > 0 ? <Row label="Discount" value={`-${formatPence(discount)}`} /> : null}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          paddingTop: theme.space[3],
          marginTop: theme.space[2],
          borderTop: `1px solid ${theme.color.border}`,
        }}
      >
        <span style={{ fontSize: theme.type.size.md, color: theme.color.ink, fontWeight: theme.type.weight.semibold }}>Total</span>
        <span style={{ fontSize: theme.type.size.xxl, fontWeight: theme.type.weight.semibold, color: theme.color.ink, fontVariantNumeric: 'tabular-nums' }}>
          {formatPence(total)}
        </span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>{label}</span>
      <span style={{ color: theme.color.ink, fontVariantNumeric: 'tabular-nums', fontSize: theme.type.size.base }}>{value}</span>
    </div>
  );
}
