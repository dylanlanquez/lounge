import type { Meta, StoryObj } from '@storybook/react';
import { Toast } from './Toast.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof Toast> = {
  title: 'Primitives/Toast',
  component: Toast,
  parameters: { layout: 'centered' },
  argTypes: {
    tone: { control: 'select', options: ['success', 'error', 'warning', 'info'] },
  },
  decorators: [
    (Story) => (
      <div style={{ padding: theme.space[8], background: theme.color.bg }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type S = StoryObj<typeof Toast>;

export const Success: S = {
  args: { tone: 'success', title: '£45.00 paid', description: 'Receipt sent to sarah@example.com.', duration: 0 },
};
export const Error: S = {
  args: {
    tone: 'error',
    title: 'Payment failed',
    description: 'Reader could not read the card. Ask the customer to try again.',
    duration: 0,
  },
};
export const Warning: S = {
  args: {
    tone: 'warning',
    title: 'Calendly sync paused',
    description: 'Last refresh 12 minutes ago. Tap to retry.',
    duration: 0,
  },
};
export const Info: S = {
  args: { tone: 'info', title: 'Sarah arrived. Walk-in opened.', duration: 0 },
};
