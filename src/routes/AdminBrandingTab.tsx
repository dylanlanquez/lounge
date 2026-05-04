import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Clock, Image as ImageIcon, Mail, Scale, Trash2, Upload } from 'lucide-react';
import { Button, Card, Checkbox, Input, Skeleton, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import {
  type ClinicSettings,
  type OpeningHoursDay,
  type OpeningHoursWeek,
  saveClinicSetting,
  useClinicSettings,
} from '../lib/queries/clinicSettings.ts';
import { useEditableLocation, saveLocation } from '../lib/queries/locations.ts';
import { supabase } from '../lib/supabase.ts';

// Branding & clinic admin tab.
//
// Five sections in one tab. Each card holds local draft state and a
// Save button — saving writes the affected key(s) back to lng_settings
// (or to the shared `locations` row for clinic name/address). Other
// cards keep their own state, so the admin can edit one block at a
// time without losing progress in another.
//
// Inline-styled to match Lounge's house style; no global CSS.

type Toast = { tone: 'success' | 'error' | 'info'; title: string; description?: string };

export function AdminBrandingTab() {
  const settings = useClinicSettings();
  const location = useEditableLocation();
  const [toast, setToast] = useState<Toast | null>(null);

  const loading = settings.loading || location.loading;
  const error = settings.error ?? location.error;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <header>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Branding &amp; clinic
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          One source of truth. Changes here update every transactional email and every
          {' {{placeholder}} '}across all templates.
        </p>
      </header>

      {loading ? (
        <Card padding="md">
          <Skeleton height={64} />
        </Card>
      ) : error ? (
        <Card padding="md">
          <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
            Couldn't load settings: {error}
          </p>
        </Card>
      ) : (
        <>
          <BrandingCard data={settings.data} onRefresh={settings.refresh} onToast={setToast} />
          <SenderCard data={settings.data} onRefresh={settings.refresh} onToast={setToast} />
          <ClinicCard
            settings={settings.data}
            location={location.data}
            onRefresh={() => {
              settings.refresh();
              location.refresh();
            }}
            onToast={setToast}
          />
          <OpeningHoursCard
            value={settings.data.openingHours}
            onRefresh={settings.refresh}
            onToast={setToast}
          />
          <LegalCard data={settings.data} onRefresh={settings.refresh} onToast={setToast} />
        </>
      )}

      {toast ? (
        <div
          style={{
            position: 'fixed',
            bottom: theme.space[6],
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
          }}
        >
          <Toast
            tone={toast.tone}
            title={toast.title}
            description={toast.description}
            onDismiss={() => setToast(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section shell
// ─────────────────────────────────────────────────────────────────────────────

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3] }}>
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
            border: `1px solid ${theme.color.border}`,
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {title}
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
            }}
          >
            {description}
          </p>
          {children}
        </div>
      </div>
    </Card>
  );
}

function SaveRow({
  dirty,
  saving,
  onSave,
  onReset,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: theme.space[2],
        marginTop: theme.space[4],
        paddingTop: theme.space[3],
        borderTop: `1px solid ${theme.color.border}`,
      }}
    >
      <Button variant="tertiary" onClick={onReset} disabled={!dirty || saving}>
        Cancel
      </Button>
      <Button variant="primary" onClick={onSave} disabled={!dirty || saving} loading={saving}>
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );
}

function FieldGroup({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>{children}</div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Branding card
// ─────────────────────────────────────────────────────────────────────────────

function BrandingCard({
  data,
  onRefresh,
  onToast,
}: {
  data: ClinicSettings;
  onRefresh: () => void;
  onToast: (t: Toast) => void;
}) {
  const [logoUrl, setLogoUrl] = useState(data.brandLogoUrl);
  const [logoShow, setLogoShow] = useState(data.brandLogoShow);
  const [logoMaxWidth, setLogoMaxWidth] = useState(data.brandLogoMaxWidth);
  const [accent, setAccent] = useState(data.brandAccentColor);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLogoUrl(data.brandLogoUrl);
    setLogoShow(data.brandLogoShow);
    setLogoMaxWidth(data.brandLogoMaxWidth);
    setAccent(data.brandAccentColor);
  }, [data.brandLogoUrl, data.brandLogoShow, data.brandLogoMaxWidth, data.brandAccentColor]);

  const dirty =
    logoUrl !== data.brandLogoUrl ||
    logoShow !== data.brandLogoShow ||
    logoMaxWidth !== data.brandLogoMaxWidth ||
    accent !== data.brandAccentColor;

  const reset = () => {
    setLogoUrl(data.brandLogoUrl);
    setLogoShow(data.brandLogoShow);
    setLogoMaxWidth(data.brandLogoMaxWidth);
    setAccent(data.brandAccentColor);
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        saveClinicSetting('brandLogoUrl', logoUrl.trim()),
        saveClinicSetting('brandLogoShow', logoShow),
        saveClinicSetting('brandLogoMaxWidth', logoMaxWidth),
        saveClinicSetting('brandAccentColor', accent.trim()),
      ]);
      onRefresh();
      onToast({ tone: 'success', title: 'Branding saved' });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not save branding',
        description: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setSaving(false);
    }
  };

  const onUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      onToast({ tone: 'error', title: 'Pick an image file (PNG, JPG, SVG)' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      onToast({ tone: 'error', title: 'Logo too large', description: 'Keep it under 2MB.' });
      return;
    }
    setUploading(true);
    try {
      // Path like `logo/2026-05-04T12-34-56.png`. The timestamp gives
      // us a fresh URL each upload so email clients refresh their
      // cache instead of serving a stale logo.
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
      const path = `logo/${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('branding')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw new Error(upErr.message);
      const { data: pub } = supabase.storage.from('branding').getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error('Could not resolve public URL for the upload');
      // Stage the URL in the form state. The user still needs to hit
      // Save to publish — keeps the "must be locked in" rule the
      // admin asked for. Until then, the live preview keeps showing
      // the previously-saved logo.
      setLogoUrl(pub.publicUrl);
      onToast({
        tone: 'info',
        title: 'Logo uploaded',
        description: 'Hit Save changes to publish it. It won\'t go out in emails until you do.',
      });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Upload failed',
        description: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onRemove = () => {
    setLogoUrl('');
  };

  return (
    <Section
      icon={<ImageIcon size={16} aria-hidden />}
      title="Branding"
      description="Logo and accent colour applied to every transactional email. Edits aren't live until you hit Save changes."
    >
      <FieldGroup>
        <Input
          label="Logo URL"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://lounge.venneir.com/lounge-logo.png"
          helper="Paste a publicly fetchable URL, or use Upload. Email clients can't see localhost or auth-gated images."
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
            }}
          />
          <Button
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            loading={uploading}
            disabled={uploading}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Upload size={14} aria-hidden /> Upload logo
            </span>
          </Button>
          <Button
            variant="tertiary"
            onClick={onRemove}
            disabled={uploading || !logoUrl}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Trash2 size={14} aria-hidden /> Remove logo
            </span>
          </Button>
          {dirty ? (
            <span
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.warn,
                fontWeight: theme.type.weight.medium,
              }}
            >
              Unsaved changes
            </span>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], flexWrap: 'wrap' }}>
          <Checkbox
            label="Show logo at the top of emails"
            checked={logoShow}
            onChange={setLogoShow}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <SliderRow
            label="Logo max-width"
            unit="px"
            min={60}
            max={240}
            value={logoMaxWidth}
            onChange={setLogoMaxWidth}
          />
          <ColorRow label="Accent colour" value={accent} onChange={setAccent} />
        </div>
        {/* Preview always shows the SAVED state, not the in-flight
            edit — once the user clicks Save the data refreshes and
            the preview updates with it. Prevents accidental
            "looks-fine-while-typing → saved-with-typo" outcomes. */}
        <LogoPreview
          publishedUrl={data.brandLogoUrl}
          publishedMaxWidth={data.brandLogoMaxWidth}
          publishedShow={data.brandLogoShow}
        />
      </FieldGroup>
      <SaveRow dirty={dirty} saving={saving} onSave={onSave} onReset={reset} />
    </Section>
  );
}

function LogoPreview({
  publishedUrl,
  publishedMaxWidth,
  publishedShow,
}: {
  publishedUrl: string;
  publishedMaxWidth: number;
  publishedShow: boolean;
}) {
  return (
    <div>
      <span
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          marginBottom: theme.space[1],
        }}
      >
        Currently published
      </span>
      <div
        style={{
          background: theme.color.bg,
          border: `1px dashed ${theme.color.border}`,
          borderRadius: theme.radius.input,
          padding: theme.space[5],
          textAlign: 'center',
          minHeight: 80,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {!publishedShow ? (
          <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.xs }}>
            Logo hidden in emails
          </span>
        ) : publishedUrl ? (
          <img
            src={publishedUrl}
            alt="Brand logo preview"
            style={{ maxWidth: publishedMaxWidth, maxHeight: 80, objectFit: 'contain' }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.xs }}>
            No logo set
          </span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Email sender card
// ─────────────────────────────────────────────────────────────────────────────

function SenderCard({
  data,
  onRefresh,
  onToast,
}: {
  data: ClinicSettings;
  onRefresh: () => void;
  onToast: (t: Toast) => void;
}) {
  const [fromName, setFromName] = useState(data.fromName);
  const [replyTo, setReplyTo] = useState(data.replyTo);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFromName(data.fromName);
    setReplyTo(data.replyTo);
  }, [data.fromName, data.replyTo]);

  const dirty = fromName !== data.fromName || replyTo !== data.replyTo;
  const reset = () => {
    setFromName(data.fromName);
    setReplyTo(data.replyTo);
  };
  const onSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        saveClinicSetting('fromName', fromName.trim()),
        saveClinicSetting('replyTo', replyTo.trim()),
      ]);
      onRefresh();
      onToast({ tone: 'success', title: 'Sender saved' });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not save sender',
        description: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      icon={<Mail size={16} aria-hidden />}
      title="Email sender"
      description='What patients see in their inbox before they open the email.'
    >
      <FieldGroup>
        <Input
          label="From name"
          value={fromName}
          onChange={(e) => setFromName(e.target.value)}
          placeholder="Venneir Lounge"
        />
        <Input
          label="Reply-to email"
          value={replyTo}
          onChange={(e) => setReplyTo(e.target.value)}
          placeholder="hello@venneir.com"
          helper="Where patient replies land. Empty falls back to the sending address."
          type="email"
        />
      </FieldGroup>
      <SaveRow dirty={dirty} saving={saving} onSave={onSave} onReset={reset} />
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Clinic card — name/address/city/phone (locations row) + email/website/booking/map (lng_settings)
// ─────────────────────────────────────────────────────────────────────────────

function ClinicCard({
  settings,
  location,
  onRefresh,
  onToast,
}: {
  settings: ClinicSettings;
  location: { id: string; name: string; city: string | null; address: string | null; phone: string | null } | null;
  onRefresh: () => void;
  onToast: (t: Toast) => void;
}) {
  const [name, setName] = useState(location?.name ?? '');
  const [city, setCity] = useState(location?.city ?? '');
  const [address, setAddress] = useState(location?.address ?? '');
  const [phone, setPhone] = useState(location?.phone ?? '');
  const [publicEmail, setPublicEmail] = useState(settings.publicEmail);
  const [websiteUrl, setWebsiteUrl] = useState(settings.websiteUrl);
  const [bookingUrl, setBookingUrl] = useState(settings.bookingUrl);
  const [mapUrl, setMapUrl] = useState(settings.mapUrl);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(location?.name ?? '');
    setCity(location?.city ?? '');
    setAddress(location?.address ?? '');
    setPhone(location?.phone ?? '');
  }, [location?.name, location?.city, location?.address, location?.phone]);
  useEffect(() => {
    setPublicEmail(settings.publicEmail);
    setWebsiteUrl(settings.websiteUrl);
    setBookingUrl(settings.bookingUrl);
    setMapUrl(settings.mapUrl);
  }, [settings.publicEmail, settings.websiteUrl, settings.bookingUrl, settings.mapUrl]);

  const dirty =
    name !== (location?.name ?? '') ||
    city !== (location?.city ?? '') ||
    address !== (location?.address ?? '') ||
    phone !== (location?.phone ?? '') ||
    publicEmail !== settings.publicEmail ||
    websiteUrl !== settings.websiteUrl ||
    bookingUrl !== settings.bookingUrl ||
    mapUrl !== settings.mapUrl;

  const reset = () => {
    setName(location?.name ?? '');
    setCity(location?.city ?? '');
    setAddress(location?.address ?? '');
    setPhone(location?.phone ?? '');
    setPublicEmail(settings.publicEmail);
    setWebsiteUrl(settings.websiteUrl);
    setBookingUrl(settings.bookingUrl);
    setMapUrl(settings.mapUrl);
  };

  const onSave = async () => {
    if (!location) {
      onToast({ tone: 'error', title: 'No location loaded' });
      return;
    }
    setSaving(true);
    try {
      await Promise.all([
        saveLocation({
          id: location.id,
          name: name.trim(),
          city: city.trim() || null,
          address: address.trim() || null,
          phone: phone.trim() || null,
        }),
        saveClinicSetting('publicEmail', publicEmail.trim()),
        saveClinicSetting('websiteUrl', websiteUrl.trim()),
        saveClinicSetting('bookingUrl', bookingUrl.trim()),
        saveClinicSetting('mapUrl', mapUrl.trim()),
      ]);
      onRefresh();
      onToast({ tone: 'success', title: 'Clinic info saved' });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not save clinic info',
        description: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      icon={<Building2 size={16} aria-hidden />}
      title="Clinic info"
      description="Name, address, phone and contact links. Pulled into emails as variables (locationName, locationAddress, websiteUrl, bookingLink, etc.)."
    >
      <FieldGroup>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <Input label="Clinic name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <Input
          label="Street address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="123 High Street"
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <Input
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+44 ..."
          />
          <Input
            label="Public email"
            value={publicEmail}
            onChange={(e) => setPublicEmail(e.target.value)}
            placeholder="hello@venneir.com"
            type="email"
          />
        </div>
        <Input
          label="Website"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
          placeholder="https://venneir.com"
        />
        <Input
          label="Booking link"
          value={bookingUrl}
          onChange={(e) => setBookingUrl(e.target.value)}
          placeholder="https://venneir.com/book"
          helper='Used as {{bookingLink}} for "Book your next appointment" CTAs.'
        />
        <Input
          label="Map URL"
          value={mapUrl}
          onChange={(e) => setMapUrl(e.target.value)}
          placeholder="https://maps.google.com/?q=..."
          helper="Optional. Shown next to the address in confirmation emails."
        />
      </FieldGroup>
      <SaveRow dirty={dirty} saving={saving} onSave={onSave} onReset={reset} />
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening hours card
// ─────────────────────────────────────────────────────────────────────────────

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function OpeningHoursCard({
  value,
  onRefresh,
  onToast,
}: {
  value: OpeningHoursWeek;
  onRefresh: () => void;
  onToast: (t: Toast) => void;
}) {
  const [draft, setDraft] = useState<OpeningHoursWeek>(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(value), [draft, value]);
  const reset = () => setDraft(value);

  const onSave = async () => {
    setSaving(true);
    try {
      await saveClinicSetting('openingHours', draft);
      onRefresh();
      onToast({ tone: 'success', title: 'Opening times saved' });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not save opening times',
        description: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setSaving(false);
    }
  };

  const updateDay = (idx: number, day: OpeningHoursDay) => {
    const next = [...draft] as OpeningHoursDay[];
    next[idx] = day;
    setDraft(next as unknown as OpeningHoursWeek);
  };

  return (
    <Section
      icon={<Clock size={16} aria-hidden />}
      title="Opening times"
      description="Used as {{openingHoursToday}} and {{openingHoursWeek}} in templates."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        {DAY_LABELS.map((label, idx) => (
          <DayRow key={label} label={label} value={draft[idx]!} onChange={(d) => updateDay(idx, d)} />
        ))}
      </div>
      <SaveRow dirty={dirty} saving={saving} onSave={onSave} onReset={reset} />
    </Section>
  );
}

function DayRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: OpeningHoursDay;
  onChange: (next: OpeningHoursDay) => void;
}) {
  const closed = value.closed === true;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '60px 1fr 1fr 100px',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      <span
        style={{
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
        }}
      >
        {label}
      </span>
      <Input
        label=""
        value={closed ? '' : value.open ?? ''}
        onChange={(e) =>
          onChange({ open: e.target.value, close: closed ? '17:00' : value.close ?? '17:00' })
        }
        placeholder="09:00"
        type="time"
        disabled={closed}
      />
      <Input
        label=""
        value={closed ? '' : value.close ?? ''}
        onChange={(e) =>
          onChange({ open: closed ? '09:00' : value.open ?? '09:00', close: e.target.value })
        }
        placeholder="18:00"
        type="time"
        disabled={closed}
      />
      <Checkbox
        label="Closed"
        checked={closed}
        onChange={(c) =>
          onChange(c ? { closed: true } : { open: '09:00', close: '18:00' })
        }
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Legal card
// ─────────────────────────────────────────────────────────────────────────────

function LegalCard({
  data,
  onRefresh,
  onToast,
}: {
  data: ClinicSettings;
  onRefresh: () => void;
  onToast: (t: Toast) => void;
}) {
  const [companyNumber, setCompanyNumber] = useState(data.companyNumber);
  const [vatNumber, setVatNumber] = useState(data.vatNumber);
  const [registeredAddress, setRegisteredAddress] = useState(data.registeredAddress);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCompanyNumber(data.companyNumber);
    setVatNumber(data.vatNumber);
    setRegisteredAddress(data.registeredAddress);
  }, [data.companyNumber, data.vatNumber, data.registeredAddress]);

  const dirty =
    companyNumber !== data.companyNumber ||
    vatNumber !== data.vatNumber ||
    registeredAddress !== data.registeredAddress;
  const reset = () => {
    setCompanyNumber(data.companyNumber);
    setVatNumber(data.vatNumber);
    setRegisteredAddress(data.registeredAddress);
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        saveClinicSetting('companyNumber', companyNumber.trim()),
        saveClinicSetting('vatNumber', vatNumber.trim()),
        saveClinicSetting('registeredAddress', registeredAddress.trim()),
      ]);
      onRefresh();
      onToast({ tone: 'success', title: 'Legal info saved' });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not save legal info',
        description: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      icon={<Scale size={16} aria-hidden />}
      title="Legal"
      description="UK statute requires company number and registered address on customer-facing comms for limited companies. Appended to the email footer."
    >
      <FieldGroup>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <Input
            label="Company number"
            value={companyNumber}
            onChange={(e) => setCompanyNumber(e.target.value)}
            placeholder="SC123456"
          />
          <Input
            label="VAT number"
            value={vatNumber}
            onChange={(e) => setVatNumber(e.target.value)}
            placeholder="GB123456789"
            helper="Leave empty if not VAT-registered."
          />
        </div>
        <Input
          label="Registered address"
          value={registeredAddress}
          onChange={(e) => setRegisteredAddress(e.target.value)}
          placeholder="Companies House registered address"
        />
      </FieldGroup>
      <SaveRow dirty={dirty} saving={saving} onSave={onSave} onReset={reset} />
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable bits
// ─────────────────────────────────────────────────────────────────────────────

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <span
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          marginBottom: theme.space[1],
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
        <input
          type="color"
          value={value || '#0E1414'}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 38,
            height: 38,
            border: `1px solid ${theme.color.border}`,
            borderRadius: 6,
            cursor: 'pointer',
            padding: 2,
            background: theme.color.surface,
            flexShrink: 0,
          }}
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#000000"
          style={{
            flex: 1,
            minWidth: 0,
            padding: `${theme.space[2]}px ${theme.space[3]}px`,
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            color: theme.color.ink,
            fontSize: theme.type.size.sm,
            outline: 'none',
            fontFamily: 'inherit',
            fontVariantNumeric: 'tabular-nums',
          }}
        />
      </div>
    </div>
  );
}

function SliderRow({
  label,
  unit,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div>
      <span
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          marginBottom: theme.space[1],
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1, accentColor: theme.color.accent }}
        />
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
            minWidth: 56,
            textAlign: 'right',
          }}
        >
          {value}
          {unit}
        </span>
      </div>
    </div>
  );
}
