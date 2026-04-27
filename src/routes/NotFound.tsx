import { Link } from 'react-router-dom';
import { theme } from '../theme/index.ts';

export function NotFound() {
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
        gap: theme.space[4],
      }}
    >
      <h1
        style={{
          fontSize: theme.type.size.xxl,
          fontWeight: theme.type.weight.semibold,
          margin: 0,
          letterSpacing: theme.type.tracking.tight,
        }}
      >
        Page not found
      </h1>
      <p
        style={{
          color: theme.color.inkMuted,
          fontSize: theme.type.size.md,
          margin: 0,
          textAlign: 'center',
        }}
      >
        The page you were looking for does not exist.
      </p>
      <Link
        to="/"
        style={{
          marginTop: theme.space[4],
          padding: `${theme.space[3]}px ${theme.space[6]}px`,
          background: theme.color.ink,
          color: theme.color.surface,
          borderRadius: theme.radius.pill,
          fontWeight: theme.type.weight.medium,
        }}
      >
        Go home
      </Link>
    </main>
  );
}
