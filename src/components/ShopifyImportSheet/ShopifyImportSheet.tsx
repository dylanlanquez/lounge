import { useEffect, useMemo, useState } from 'react';
import { Check, Package, RefreshCw, Search, ShoppingBag } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';
import { theme } from '../../theme/index.ts';
import {
  type ShopifyFetchResult,
  type ShopifyProduct,
  fetchShopifyProducts,
  importShopifyProduct,
} from '../../lib/queries/catalogue.ts';

export interface ShopifyImportSheetProps {
  open: boolean;
  onClose: () => void;
  // Shopify product ids already in the Lounge catalogue, so they show as
  // added and can't be imported twice.
  existingShopifyIds: ReadonlySet<string>;
  // Refresh the catalogue list after a successful import.
  onImported: () => void;
}

const money = (n: number | null): string => (n != null ? `£${n.toFixed(2)}` : '—');

export function ShopifyImportSheet({
  open,
  onClose,
  existingShopifyIds,
  onImported,
}: ShopifyImportSheetProps) {
  const [result, setResult] = useState<ShopifyFetchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState('Retail');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Fetch the catalogue each time the sheet opens (and on retry).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setResult(null);
    setSelected(new Set());
    setImportError(null);
    (async () => {
      const r = await fetchShopifyProducts();
      if (!cancelled) {
        setResult(r);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, nonce]);

  const products = useMemo(() => (result?.ok ? result.products : []), [result]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.title.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q)
    );
  }, [products, search]);

  const importable = (p: ShopifyProduct) => !existingShopifyIds.has(p.product_id);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedCount = selected.size;

  const handleImport = async () => {
    if (selectedCount === 0) return;
    setBusy(true);
    setImportError(null);
    try {
      const toImport = products.filter((p) => selected.has(p.product_id) && importable(p));
      for (const p of toImport) {
        await importShopifyProduct(p, category);
      }
      onImported();
      onClose();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Import from Shopify"
      description="Pick products from the Venneir catalogue to add as Lounge products."
      footer={
        result?.ok ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
            {importError ? (
              <span style={{ fontSize: theme.type.size.sm, color: theme.color.alert, marginRight: 'auto' }}>
                {importError}
              </span>
            ) : (
              <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted, marginRight: 'auto' }}>
                {selectedCount === 0 ? 'Select products to import' : `${selectedCount} selected`}
              </span>
            )}
            <Button variant="secondary" size="md" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" size="md" onClick={handleImport} disabled={selectedCount === 0 || busy} loading={busy}>
              {selectedCount > 0 ? `Add ${selectedCount} product${selectedCount === 1 ? '' : 's'}` : 'Add products'}
            </Button>
          </div>
        ) : undefined
      }
    >
      {loading ? (
        <CenterNote icon={<RefreshCw size={22} aria-hidden style={{ animation: 'lng-spin 0.8s linear infinite' }} />}>
          Loading the Shopify catalogue…
          <style>{`@keyframes lng-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
        </CenterNote>
      ) : result && !result.ok && result.reason === 'not_configured' ? (
        <CenterNote icon={<ShoppingBag size={22} aria-hidden />} title="Shopify isn't connected yet">
          Add the Venneir Shopify Admin API token to enable importing. Once it's set, reopen this panel.
        </CenterNote>
      ) : result && !result.ok ? (
        <CenterNote icon={<ShoppingBag size={22} aria-hidden />} title="Couldn't reach Shopify">
          {result.message ?? 'Please try again.'}
          <div style={{ marginTop: theme.space[4] }}>
            <Button variant="secondary" size="md" onClick={() => setNonce((n) => n + 1)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                <RefreshCw size={16} aria-hidden /> Retry
              </span>
            </Button>
          </div>
        </CenterNote>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: theme.space[4],
            }}
          >
            <Input
              label="Category for imported products"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Retail"
              maxLength={60}
            />
            <Input
              label="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Title or SKU"
              leadingIcon={<Search size={16} aria-hidden />}
            />
          </div>

          {filtered.length === 0 ? (
            <p style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted, textAlign: 'center', padding: `${theme.space[6]}px 0` }}>
              No products match.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {filtered.map((p) => {
                const added = !importable(p);
                const checked = added || selected.has(p.product_id);
                return (
                  <li key={p.product_id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-disabled={added || undefined}
                      onClick={() => !added && toggle(p.product_id)}
                      style={{
                        appearance: 'none',
                        width: '100%',
                        textAlign: 'left',
                        fontFamily: 'inherit',
                        cursor: added ? 'default' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: theme.space[3],
                        padding: theme.space[3],
                        borderRadius: theme.radius.input,
                        border: `1.5px solid ${selected.has(p.product_id) ? theme.color.accent : theme.color.border}`,
                        background: selected.has(p.product_id) ? theme.color.accentBg : theme.color.surface,
                        opacity: added ? 0.55 : 1,
                        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                      }}
                    >
                      <Thumb src={p.image_url} alt={p.title} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: 'block',
                            fontSize: theme.type.size.base,
                            fontWeight: theme.type.weight.semibold,
                            color: theme.color.ink,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {p.title}
                        </span>
                        <span style={{ display: 'block', marginTop: 2, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
                          {money(p.price)}
                          {p.sku ? ` · ${p.sku}` : ''}
                        </span>
                      </span>
                      {added ? (
                        <span
                          style={{
                            fontSize: theme.type.size.xs,
                            fontWeight: theme.type.weight.semibold,
                            color: theme.color.accent,
                            background: theme.color.accentBg,
                            padding: `${theme.space[1]}px ${theme.space[3]}px`,
                            borderRadius: theme.radius.pill,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          Added
                        </span>
                      ) : (
                        <span
                          aria-hidden
                          style={{
                            width: 22,
                            height: 22,
                            flexShrink: 0,
                            borderRadius: theme.radius.pill,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: selected.has(p.product_id) ? theme.color.accent : 'transparent',
                            border: selected.has(p.product_id) ? 'none' : `1.5px solid ${theme.color.border}`,
                            color: theme.color.surface,
                          }}
                        >
                          {selected.has(p.product_id) ? <Check size={14} strokeWidth={3} /> : null}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </BottomSheet>
  );
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  return (
    <div
      style={{
        width: 48,
        height: 48,
        flexShrink: 0,
        borderRadius: 12,
        overflow: 'hidden',
        background: 'rgba(14,20,20,0.05)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: theme.color.inkSubtle,
      }}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={(e) => {
            (e.currentTarget as HTMLElement).style.display = 'none';
          }}
        />
      ) : (
        <Package size={20} aria-hidden />
      )}
    </div>
  );
}

function CenterNote({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: theme.space[2],
        padding: `${theme.space[10]}px ${theme.space[4]}px`,
        color: theme.color.inkMuted,
      }}
    >
      <span
        style={{
          width: 48,
          height: 48,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: theme.space[1],
        }}
      >
        {icon}
      </span>
      {title ? (
        <span style={{ fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          {title}
        </span>
      ) : null}
      <span style={{ fontSize: theme.type.size.sm, maxWidth: 360 }}>{children}</span>
    </div>
  );
}
