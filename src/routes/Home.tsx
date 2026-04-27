import { theme } from '../theme/index.ts';

// Placeholder home screen. Replaced in Phase 1 slice 2 (today view).
export function Home() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[8],
        background: theme.color.bg,
      }}
    >
      <img
        src="/lounge-logo.png"
        alt="Lounge"
        style={{ width: 'min(40vw, 240px)', height: 'auto', marginBottom: theme.space[8] }}
      />
      <p
        style={{
          color: theme.color.inkMuted,
          fontSize: theme.type.size.md,
          margin: 0,
          textAlign: 'center',
        }}
      >
        Walk-ins and appointments by Venneir.
      </p>
    </main>
  );
}
