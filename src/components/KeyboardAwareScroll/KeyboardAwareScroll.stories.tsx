import type { Meta, StoryObj } from '@storybook/react';
import { KeyboardAwareScroll } from './KeyboardAwareScroll.tsx';
import { Input } from '../Input/Input.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof KeyboardAwareScroll> = {
  title: 'Primitives/KeyboardAwareScroll',
  component: KeyboardAwareScroll,
  parameters: { layout: 'fullscreen' },
};
export default meta;

export const TabletForm: StoryObj = {
  render: () => (
    <KeyboardAwareScroll>
      <div style={{ padding: theme.space[8], maxWidth: 480, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: theme.type.size.xl, fontWeight: theme.type.weight.semibold }}>
          New walk-in
        </h1>
        <p style={{ color: theme.color.inkMuted, margin: `${theme.space[2]}px 0 ${theme.space[8]}px` }}>
          On a real tablet, focus the inputs at the bottom — the form scrolls them above the keyboard.
        </p>
        <Card padding="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            <Input label="First name" />
            <Input label="Last name" />
            <Input label="Phone" type="tel" />
            <Input label="Email" type="email" />
            <Input label="Date of birth" placeholder="dd / mm / yyyy" />
            <Input label="Allergies" />
            <Button variant="primary" size="lg" fullWidth showArrow>
              Continue
            </Button>
          </div>
        </Card>
      </div>
    </KeyboardAwareScroll>
  ),
};
