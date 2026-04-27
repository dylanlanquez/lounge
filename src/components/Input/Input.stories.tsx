import type { Meta, StoryObj } from '@storybook/react';
import { Mail, Phone, Search } from 'lucide-react';
import { Input } from './Input.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof Input> = {
  title: 'Primitives/Input',
  component: Input,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ width: 360, padding: theme.space[6], background: theme.color.bg }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type S = StoryObj<typeof Input>;

export const Default: S = { args: { label: 'Email', placeholder: 'sarah@example.com' } };
export const WithHelper: S = {
  args: { label: 'Phone', placeholder: '07700 900 000', helper: 'UK format, no spaces required.' },
};
export const WithError: S = {
  args: { label: 'PIN', placeholder: '6 digits', error: 'PIN must be exactly 6 digits.' },
};
export const Password: S = {
  args: { label: 'PIN', type: 'password', placeholder: '••••••' },
};
export const Email: S = {
  args: {
    label: 'Email',
    type: 'email',
    placeholder: 'sarah@example.com',
    leadingIcon: <Mail size={20} />,
  },
};
export const PhoneSearch: S = {
  args: {
    label: 'Find patient',
    placeholder: 'Phone, name, or LWO ref',
    leadingIcon: <Search size={20} />,
    trailingIcon: <Phone size={20} />,
  },
};
export const Disabled: S = { args: { label: 'Account', value: 'sarah@example.com', disabled: true } };
