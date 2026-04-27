import type { Meta, StoryObj } from '@storybook/react';
import { Skeleton } from './Skeleton.tsx';
import { Card } from '../Card/Card.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof Skeleton> = {
  title: 'Primitives/Skeleton',
  component: Skeleton,
  parameters: { layout: 'centered' },
};
export default meta;

type S = StoryObj<typeof Skeleton>;

export const SingleLine: S = { args: { width: 240, height: 16 } };

export const ParagraphAndCircle: S = {
  render: () => (
    <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <Skeleton width={180} height={20} />
      <Skeleton width="100%" height={14} />
      <Skeleton width="92%" height={14} />
      <Skeleton width="60%" height={14} />
    </div>
  ),
};

export const AppointmentCard: S = {
  render: () => (
    <div style={{ width: 360, padding: theme.space[6], background: theme.color.bg }}>
      <Card padding="md">
        <div style={{ display: 'flex', gap: theme.space[3] }}>
          <Skeleton width={4} height={48} radius={2} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <Skeleton width={140} height={18} />
            <Skeleton width={200} height={14} />
          </div>
        </div>
      </Card>
    </div>
  ),
};
