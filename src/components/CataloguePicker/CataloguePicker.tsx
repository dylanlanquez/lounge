import { useMemo, useState } from 'react';
import { ChevronRight, Minus, Package, Plus, Sparkles } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { Toast } from '../Toast/Toast.tsx';
import { theme } from '../../theme/index.ts';
import {
  type CatalogueRow,
  useCatalogueActive,
} from '../../lib/queries/catalogue.ts';
import { findMatches, type MatchCriteria, totalForQty } from '../../lib/catalogueMatch.ts';
import {
  type IntakeAnswer,
  archToAnatomy,
  filterCareIntake,
} from '../../lib/queries/appointments.ts';
import {
  addCatalogueItemsToCart,
  type CatalogueAddOptions,
} from '../../lib/queries/carts.ts';

export interface CataloguePickerProps {
  open: boolean;
  onClose: () => void;
  cartId: string | null;
  // Pulled from the patient's appointment so the picker can suggest
  // catalogue rows that fit the booking (intake answers + Calendly
  // event type). Walk-ins pass null intake / event_type_label.
  intake: IntakeAnswer[] | null;
  eventTypeLabel: string | null;
  onItemAdded: () => void;
}

export function CataloguePicker({
  open,
  onClose,
  cartId,
  intake,
  eventTypeLabel,
  onItemAdded,
}: CataloguePickerProps) {
  const { rows, loading, error } = useCatalogueActive();
  const [selected, setSelected] = useState<CatalogueRow | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  const criteria = useMemo(
    () => criteriaFromAppointment(intake, eventTypeLabel),
    [intake, eventTypeLabel]
  );
  const suggestions = useMemo(() => findMatches(rows, criteria), [rows, criteria]);

  const grouped = useMemo(() => {
    const m = new Map<string, CatalogueRow[]>();
    for (const r of rows) {
      const list = m.get(r.category) ?? [];
      list.push(r);
      m.set(r.category, list);
    }
    return [...m.entries()];
  }, [rows]);

  const handleClose = () => {
    setSelected(null);
    onClose();
  };

  const handleAdded = () => {
    setSelected(null);
    setToast({ tone: 'success', title: 'Added to cart' });
    onItemAdded();
  };

  return (
    <>
      <BottomSheet
        open={open}
        onClose={handleClose}
        onBack={selected ? () => setSelected(null) : undefined}
        title={selected ? selected.name : 'Add item'}
        description={
          selected ? (
            <span>
              {selected.description ?? 'Configure the line and add to cart.'}
            </span>
          ) : (
            <span>
              {suggestions.length > 0
                ? `${suggestions.length} suggested for this booking, full catalogue below.`
                : 'Pick a product. Catalogue is shared with Checkpoint.'}
            </span>
          )
        }
      >
        {error ? (
          <p style={{ color: theme.color.alert, margin: 0 }}>Could not load catalogue: {error}</p>
        ) : loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <Skeleton height={56} radius={12} />
            <Skeleton height={56} radius={12} />
            <Skeleton height={56} radius={12} />
          </div>
        ) : selected ? (
          <ConfigureForm
            row={selected}
            cartId={cartId}
            onAdded={handleAdded}
            onError={(msg) => setToast({ tone: 'error', title: msg })}
          />
        ) : (
          <BrowseList
            suggestions={suggestions}
            grouped={grouped}
            onPick={setSelected}
          />
        )}
      </BottomSheet>

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 1100 }}>
          <Toast tone={toast.tone} title={toast.title} duration={2200} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </>
  );
}

// ---------- Browse mode ----------

function BrowseList({
  suggestions,
  grouped,
  onPick,
}: {
  suggestions: CatalogueRow[];
  grouped: Array<[string, CatalogueRow[]]>;
  onPick: (row: CatalogueRow) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {suggestions.length > 0 ? (
        <Section
          label="Suggested"
          icon={<Sparkles size={14} />}
          rows={suggestions}
          onPick={onPick}
          accent
        />
      ) : null}
      {grouped.map(([category, rows]) => (
        <Section key={category} label={category} rows={rows} onPick={onPick} />
      ))}
    </div>
  );
}

function Section({
  label,
  icon,
  rows,
  onPick,
  accent = false,
}: {
  label: string;
  icon?: React.ReactNode;
  rows: CatalogueRow[];
  onPick: (row: CatalogueRow) => void;
  accent?: boolean;
}) {
  return (
    <div>
      <p
        style={{
          margin: `0 0 ${theme.space[2]}px`,
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: accent ? theme.color.accent : theme.color.inkSubtle,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {icon}
        {label}
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onPick(row)}
              style={{
                appearance: 'none',
                width: '100%',
                textAlign: 'left',
                padding: theme.space[3],
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
                borderRadius: 14,
                fontFamily: 'inherit',
                fontSize: theme.type.size.base,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: theme.space[3],
                minHeight: 64,
                transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = theme.color.ink;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
              }}
            >
              <Thumb src={row.image_url} alt={row.name} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.name}
                </span>
                {row.description ? (
                  <span
                    style={{
                      display: 'block',
                      marginTop: 2,
                      fontSize: theme.type.size.sm,
                      color: theme.color.inkMuted,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.description}
                  </span>
                ) : null}
              </span>
              <span
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: theme.type.weight.semibold,
                  whiteSpace: 'nowrap',
                  color: theme.color.ink,
                }}
              >
                £{row.unit_price.toFixed(2)}
                {row.unit_label ? (
                  <span style={{ color: theme.color.inkMuted, fontWeight: theme.type.weight.regular, fontSize: theme.type.size.xs }}>
                    {' '}
                    · {row.unit_label}
                  </span>
                ) : null}
              </span>
              <ChevronRight size={18} color={theme.color.inkSubtle} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Configure mode ----------

function ConfigureForm({
  row,
  cartId,
  onAdded,
  onError,
}: {
  row: CatalogueRow;
  cartId: string | null;
  onAdded: () => void;
  onError: (msg: string) => void;
}) {
  const [qty, setQty] = useState(1);
  const [arch, setArch] = useState<'upper' | 'lower' | null>(null);
  const [shade, setShade] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // arch_match='single' is the only state where the receptionist must
  // pick upper / lower. 'both' implies both arches always; 'any' isn't
  // arch-specific (the line just stores arch=null).
  const askArch = row.arch_match === 'single';
  const archForLine: 'upper' | 'lower' | 'both' | null =
    row.arch_match === 'both' ? 'both' : askArch ? arch : null;

  const canAdd =
    cartId != null &&
    qty >= 1 &&
    (!askArch || arch !== null);

  const submit = async () => {
    if (!cartId || !canAdd) return;
    setBusy(true);
    try {
      const opts: CatalogueAddOptions = {
        arch: archForLine,
        shade: shade.trim() || null,
        notes: notes.trim() || null,
      };
      await addCatalogueItemsToCart(cartId, row, qty, opts);
      onAdded();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not add item');
    } finally {
      setBusy(false);
    }
  };

  const lineTotal = totalForQty(row, qty);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      {row.image_url ? (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Thumb src={row.image_url} alt={row.name} size={120} />
        </div>
      ) : null}

      <div
        style={{
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          background: theme.color.accentBg,
          border: `1px solid ${theme.color.accent}`,
          borderRadius: 12,
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: theme.space[3],
        }}
      >
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          {qty > 1 && row.extra_unit_price != null
            ? `£${row.unit_price.toFixed(2)} + ${qty - 1} × £${row.extra_unit_price.toFixed(2)}`
            : `£${row.unit_price.toFixed(2)}${qty > 1 ? ` × ${qty}` : ''}`}
        </span>
        <span
          style={{
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          £{lineTotal.toFixed(2)}
        </span>
      </div>

      <Stepper label={row.unit_label ? `Quantity (${row.unit_label})` : 'Quantity'} value={qty} onChange={setQty} />

      {askArch ? (
        <div>
          <p
            style={{
              margin: `0 0 ${theme.space[2]}px`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Arch
          </p>
          <div style={{ display: 'flex', gap: theme.space[2] }}>
            <ArchPick value="upper" current={arch} onClick={() => setArch('upper')} />
            <ArchPick value="lower" current={arch} onClick={() => setArch('lower')} />
          </div>
        </div>
      ) : null}

      <Input label="Shade (optional)" value={shade} onChange={(e) => setShade(e.target.value)} placeholder="e.g. A2" />
      <Input label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. matched to upper canine" />

      <Button
        variant="primary"
        size="lg"
        showArrow
        loading={busy}
        disabled={!canAdd}
        onClick={submit}
      >
        Add to cart · £{lineTotal.toFixed(2)}
      </Button>
    </div>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <p
        style={{
          margin: `0 0 ${theme.space[2]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          fontWeight: theme.type.weight.medium,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        {label}
      </p>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
        <StepperButton aria="Decrease" onClick={() => onChange(Math.max(1, value - 1))}>
          <Minus size={16} />
        </StepperButton>
        <span
          style={{
            minWidth: 32,
            textAlign: 'center',
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
        <StepperButton aria="Increase" onClick={() => onChange(value + 1)}>
          <Plus size={16} />
        </StepperButton>
      </div>
    </div>
  );
}

function StepperButton({ aria, children, onClick }: { aria: string; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={aria}
      onClick={onClick}
      style={{
        appearance: 'none',
        width: 40,
        height: 40,
        borderRadius: theme.radius.pill,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        color: theme.color.ink,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}

function ArchPick({
  value,
  current,
  onClick,
}: {
  value: 'upper' | 'lower';
  current: 'upper' | 'lower' | null;
  onClick: () => void;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        flex: 1,
        height: 48,
        borderRadius: theme.radius.pill,
        background: selected ? theme.color.ink : theme.color.surface,
        color: selected ? theme.color.surface : theme.color.ink,
        border: selected ? 'none' : `1px solid ${theme.color.border}`,
        fontFamily: 'inherit',
        fontSize: theme.type.size.base,
        fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
        cursor: 'pointer',
        textTransform: 'capitalize',
      }}
    >
      {value}
    </button>
  );
}

// Square thumbnail with rounded clip + subtle border, fallback to Package
// glyph on a tinted background. Mirrors the admin's CatalogueThumbnail
// but kept local so the picker is self-contained.
function Thumb({ src, alt, size = 48 }: { src: string | null; alt: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: 10,
        overflow: 'hidden',
        background: src ? theme.color.surface : 'rgba(14, 20, 20, 0.04)',
        border: `1px solid ${theme.color.border}`,
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
        <Package size={Math.round(size * 0.4)} />
      )}
    </span>
  );
}

// ---------- Criteria-from-appointment helper ----------

// Maps an appointment's intake answers + Calendly event type to the
// MatchCriteria the catalogue match function uses. Best-effort: gaps in
// intake just leave a field unset, and findMatches falls back to the
// least-specific catalogue rows.
export function criteriaFromAppointment(
  intake: IntakeAnswer[] | null,
  eventTypeLabel: string | null
): MatchCriteria {
  const filtered = filterCareIntake(intake);
  const service_type = inferServiceType(eventTypeLabel);

  // Repair variant comes from the "Repair Type" / "Type of repair" intake
  // question on Denture Repair appointments.
  const repairAns = filtered.find((a) =>
    /\brepair[\s_]*type\b/i.test(a.question ?? '')
  );
  const repair_variant = repairAns?.answer.split(/\r?\n+/)[0]?.trim() || null;

  // Product key from the appliance / product / service question.
  const subjectAns = filtered.find((a) =>
    /\b(appliance|product|service|treatment)\b/i.test(a.question ?? '')
  );
  const product_key = subjectAns ? normaliseProductKey(subjectAns.answer) : null;

  // Arch from the explicit arch / jaw question, or as a fallback from
  // the answer if it looks arch-like.
  const archAns = filtered.find((a) =>
    /\b(arch|jaw|upper\s*or\s*lower|top\s*or\s*bottom)\b/i.test(a.question ?? '')
  );
  const archLabel = archAns ? archToAnatomy(archAns.answer) : undefined;
  const arch = archLabel === 'Upper'
    ? 'upper'
    : archLabel === 'Lower'
      ? 'lower'
      : archLabel === 'Upper and Lower'
        ? 'both'
        : null;

  return { service_type, product_key, repair_variant, arch };
}

// "Denture Repairs" / "Virtual Denture Repair" → 'denture_repair' etc.
function inferServiceType(label: string | null): string | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (/denture\s+repair|repair/i.test(l)) return 'denture_repair';
  if (/click[\s-]?in\s+veneer|veneer/i.test(l)) return 'click_in_veneers';
  if (/same[\s-]?day\s+appliance|appliance|impression|aligner|retainer|guard|whitening/i.test(l))
    return 'same_day_appliance';
  return null;
}

// "Whitening Trays" → "whitening_tray", "Night Guard" → "night_guard".
function normaliseProductKey(answer: string): string | null {
  const a = answer.split(/\r?\n+/)[0]?.toLowerCase().trim() ?? '';
  if (!a) return null;
  if (/retainer/.test(a)) return 'retainer';
  if (/aligner/.test(a)) return 'aligner';
  if (/night[\s-]?guard/.test(a)) return 'night_guard';
  if (/day[\s-]?guard/.test(a)) return 'day_guard';
  if (/whitening\s*kit/.test(a)) return 'whitening_kit';
  if (/whitening/.test(a)) return 'whitening_tray';
  if (/missing\s*tooth/.test(a)) return 'missing_tooth';
  if (/click[\s-]?in\s*veneer|veneer/.test(a)) return 'click_in_veneers';
  return null;
}
