import { type ReactNode, useState } from 'react';
import { Phone, Search, User } from 'lucide-react';
import { Input } from '../Input/Input.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { theme } from '../../theme/index.ts';
import {
  type PatientRow,
  usePatientSearch,
  patientFullName,
} from '../../lib/queries/patients.ts';

export interface PatientSearchProps {
  onPick: (patient: PatientRow) => void;
  onCreateNew?: (term: string) => void;
  emptyHint?: ReactNode;
  autoFocus?: boolean;
  placeholder?: string;
}

export function PatientSearch({
  onPick,
  onCreateNew,
  emptyHint,
  autoFocus = true,
  placeholder = 'Phone, name, email, or LWO ref',
}: PatientSearchProps) {
  const [term, setTerm] = useState('');
  const { data, loading } = usePatientSearch(term);
  const trimmed = term.trim();
  const showCreate = trimmed.length >= 2 && !loading && data.length === 0 && Boolean(onCreateNew);

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
          {emptyHint ?? 'Type at least two characters to search.'}
        </p>
      ) : loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <Skeleton height={56} radius={12} />
          <Skeleton height={56} radius={12} />
          <Skeleton height={56} radius={12} />
        </div>
      ) : data.length > 0 ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {data.map((p) => (
            <li key={p.id}>
              <PatientResultRow patient={p} onPick={onPick} />
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          No patient found at this location for &ldquo;{trimmed}&rdquo;.
        </p>
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
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[3],
            color: theme.color.ink,
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <User size={20} />
          <span style={{ flex: 1 }}>
            Create new patient for &ldquo;<strong>{trimmed}</strong>&rdquo;
          </span>
        </button>
      ) : null}
    </div>
  );
}

function PatientResultRow({ patient, onPick }: { patient: PatientRow; onPick: (p: PatientRow) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(patient)}
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
        cursor: 'pointer',
        fontFamily: 'inherit',
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
        {(patient.first_name?.[0] || '').toUpperCase()}
        {(patient.last_name?.[0] || '').toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontWeight: theme.type.weight.semibold, color: theme.color.ink, fontSize: theme.type.size.base }}>
          {patientFullName(patient)}
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
          <span>{patient.internal_ref}</span>
          {patient.phone ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Phone size={12} /> {patient.phone}
            </span>
          ) : null}
          {patient.lwo_ref ? <span style={{ color: theme.color.accent }}>{patient.lwo_ref}</span> : null}
        </p>
      </div>
    </button>
  );
}
