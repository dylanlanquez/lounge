import type { Meta, StoryObj } from '@storybook/react';
import { Avatar } from './Avatar.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof Avatar> = {
  title: 'Primitives/Avatar',
  component: Avatar,
  parameters: { layout: 'centered' },
  argTypes: {
    size: { control: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl'] },
    badge: { control: 'select', options: [null, 'online', 'offline'] },
  },
};
export default meta;

type S = StoryObj<typeof Avatar>;

export const Initials: S = { args: { name: 'Sarah Henderson', size: 'lg' } };

export const SizeLadder: S = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: theme.space[3] }}>
      <Avatar name="Sarah Henderson" size="xs" />
      <Avatar name="Sarah Henderson" size="sm" />
      <Avatar name="Sarah Henderson" size="md" />
      <Avatar name="Sarah Henderson" size="lg" />
      <Avatar name="Sarah Henderson" size="xl" />
    </div>
  ),
};

export const ManyNames: S = {
  render: () => (
    <div style={{ display: 'flex', gap: theme.space[3], flexWrap: 'wrap', maxWidth: 320 }}>
      {['Sarah Henderson', 'Mark Thompson', 'Dylan Lanquez', 'Jane Doe', 'A B', 'Alex', 'Priya Sharma', 'Olu Adeyemi'].map(
        (n) => (
          <Avatar key={n} name={n} size="md" />
        )
      )}
    </div>
  ),
};

export const WithBadgeOnline: S = { args: { name: 'Sarah Henderson', size: 'lg', badge: 'online' } };
export const WithBadgeOffline: S = { args: { name: 'Sarah Henderson', size: 'lg', badge: 'offline' } };
