import type { Meta, StoryObj } from '@storybook/react';
import { CalendarOff, UserPlus, WifiOff } from 'lucide-react';
import { EmptyState } from './EmptyState.tsx';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof EmptyState> = {
  title: 'Primitives/EmptyState',
  component: EmptyState,
  parameters: { layout: 'centered' },
  decorators: [(Story) => <div style={{ width: 480, background: theme.color.bg }}><Story /></div>],
};
export default meta;

type S = StoryObj<typeof EmptyState>;

export const NoAppointmentsToday: S = {
  args: {
    icon: <CalendarOff size={24} />,
    title: 'No appointments today',
    description: 'Once a Calendly booking lands or a walk-in arrives, it will appear here.',
    action: <Button variant="primary" size="md">New walk-in</Button>,
  },
};

export const NoSearchResults: S = {
  args: {
    icon: <UserPlus size={24} />,
    title: 'No patient found',
    description: 'No matches for that phone number at Motherwell. Create a new walk-in instead.',
    action: <Button variant="primary" size="md" showArrow>Create new patient</Button>,
  },
};

export const Offline: S = {
  args: {
    icon: <WifiOff size={24} />,
    title: 'Offline',
    description: 'Your tablet is not connected. Cash payments still work; card payments need a live connection.',
  },
};
