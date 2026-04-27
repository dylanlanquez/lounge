import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof Button> = {
  title: 'Primitives/Button',
  component: Button,
  parameters: { layout: 'centered' },
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'tertiary'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    children: { control: 'text' },
  },
  args: {
    children: 'Take payment',
    variant: 'primary',
    size: 'lg',
  },
};
export default meta;

type S = StoryObj<typeof Button>;

export const Primary: S = {};
export const PrimaryWithArrow: S = { args: { showArrow: true, children: 'Continue' } };
export const Secondary: S = { args: { variant: 'secondary', children: 'Cancel' } };
export const Tertiary: S = { args: { variant: 'tertiary', children: 'Forgot PIN?' } };
export const Loading: S = { args: { loading: true } };
export const Disabled: S = { args: { disabled: true } };
export const FullWidth: S = {
  args: { fullWidth: true, children: 'Sign in' },
  decorators: [(Story) => <div style={{ width: 400 }}><Story /></div>],
};

export const Sizes: S = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large (tablet primary)</Button>
    </div>
  ),
};

export const VariantsRow: S = {
  render: () => (
    <div style={{ display: 'flex', gap: theme.space[3] }}>
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="tertiary">Tertiary</Button>
    </div>
  ),
};

export const BottomAnchoredOnTablet: S = {
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div
      style={{
        position: 'relative',
        height: 480,
        background: theme.color.bg,
        padding: theme.space[6],
        overflow: 'hidden',
      }}
    >
      <p style={{ color: theme.color.inkMuted, margin: 0 }}>
        Imagine a tablet form above. The primary action sits anchored to the bottom edge with safe-area padding.
      </p>
      <Button variant="primary" size="lg" bottomAnchored showArrow>
        Continue
      </Button>
    </div>
  ),
};
