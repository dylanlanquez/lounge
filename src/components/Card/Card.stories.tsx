import type { Meta, StoryObj } from '@storybook/react';
import { Card } from './Card.tsx';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof Card> = {
  title: 'Primitives/Card',
  component: Card,
  parameters: { layout: 'centered' },
  argTypes: {
    padding: { control: 'select', options: ['none', 'sm', 'md', 'lg'] },
    elevation: { control: 'select', options: ['flat', 'raised', 'overlay'] },
  },
};
export default meta;

type S = StoryObj<typeof Card>;

export const Raised: S = {
  args: { padding: 'lg' },
  render: (a) => (
    <div style={{ width: 380, background: theme.color.bg, padding: theme.space[8] }}>
      <Card {...a}>
        <h3 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
          Sarah Henderson
        </h3>
        <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          MP-00041 • Last seen 12 Mar 2026
        </p>
      </Card>
    </div>
  ),
};

export const Flat: S = {
  args: { elevation: 'flat', padding: 'md' },
  render: (a) => (
    <div style={{ width: 380, background: theme.color.bg, padding: theme.space[8] }}>
      <Card {...a}>
        <p style={{ margin: 0, color: theme.color.ink }}>
          A flat card has no shadow. Useful when nested inside a parent that already has elevation.
        </p>
      </Card>
    </div>
  ),
};

export const InteractiveAppointmentCard: S = {
  render: () => (
    <div style={{ width: 380, background: theme.color.bg, padding: theme.space[8] }}>
      <Card padding="md" interactive role="button" tabIndex={0}>
        <div style={{ display: 'flex', gap: theme.space[3] }}>
          <div style={{ width: 4, alignSelf: 'stretch', background: theme.color.accent, borderRadius: 2 }} />
          <div style={{ flex: 1 }}>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.base,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
              }}
            >
              Sarah H.
            </p>
            <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              10:30 to 11:00 with Mark
            </p>
          </div>
        </div>
      </Card>
    </div>
  ),
};

export const VisitWithCTA: S = {
  render: () => (
    <div style={{ width: 420, background: theme.color.bg, padding: theme.space[8] }}>
      <Card padding="lg">
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Sarah H. arrived
        </h3>
        <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[6]}px`, color: theme.color.inkMuted }}>
          LWO-20260427-0001 • Walk-in
        </p>
        <div style={{ display: 'flex', gap: theme.space[3] }}>
          <Button variant="secondary">Edit details</Button>
          <Button variant="primary" showArrow>
            Build cart
          </Button>
        </div>
      </Card>
    </div>
  ),
};
