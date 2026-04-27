import type { Meta, StoryObj } from '@storybook/react';
import { StatusPill } from './StatusPill.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof StatusPill> = {
  title: 'Primitives/StatusPill',
  component: StatusPill,
  parameters: { layout: 'centered' },
  argTypes: {
    tone: {
      control: 'select',
      options: ['neutral', 'arrived', 'in_progress', 'complete', 'no_show', 'cancelled'],
    },
    size: { control: 'select', options: ['sm', 'md'] },
  },
};
export default meta;

type S = StoryObj<typeof StatusPill>;

export const Each: S = {
  render: () => (
    <div style={{ display: 'flex', gap: theme.space[3], flexWrap: 'wrap', maxWidth: 480 }}>
      <StatusPill tone="neutral">Booked</StatusPill>
      <StatusPill tone="arrived">Arrived</StatusPill>
      <StatusPill tone="in_progress">In progress</StatusPill>
      <StatusPill tone="complete">Complete</StatusPill>
      <StatusPill tone="no_show">No-show</StatusPill>
      <StatusPill tone="cancelled">Cancelled</StatusPill>
    </div>
  ),
};

export const Small: S = {
  render: () => (
    <div style={{ display: 'flex', gap: theme.space[2] }}>
      <StatusPill tone="neutral" size="sm">Booked</StatusPill>
      <StatusPill tone="arrived" size="sm">Arrived</StatusPill>
      <StatusPill tone="complete" size="sm">Done</StatusPill>
    </div>
  ),
};
