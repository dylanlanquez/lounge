import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Dialog } from './Dialog.tsx';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof Dialog> = {
  title: 'Primitives/Dialog',
  component: Dialog,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type S = StoryObj<typeof Dialog>;

export const ConfirmRefund: S = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div style={{ height: '100dvh', background: theme.color.bg, padding: theme.space[8] }}>
        <Button onClick={() => setOpen(true)}>Open confirm dialog</Button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Refund £45.00?"
          description="The customer will see this on their card statement within 5 working days."
          footer={
            <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>Refund £45.00</Button>
            </div>
          }
        >
          <p style={{ margin: 0, color: theme.color.ink }}>
            This refund hits the original card via Stripe Terminal. Make sure the customer has their card with them.
          </p>
        </Dialog>
      </div>
    );
  },
};

export const UnsavedChanges: S = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div style={{ height: '100dvh', background: theme.color.bg, padding: theme.space[8] }}>
        <Button onClick={() => setOpen(true)}>Open unsaved-changes dialog</Button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="You have unsaved changes"
          description="Discard them and leave, or go back and save?"
          dismissable={false}
          footer={
            <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
              <Button variant="tertiary" onClick={() => setOpen(false)}>Discard and leave</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>Go back and save</Button>
            </div>
          }
        >
          <p style={{ margin: 0, color: theme.color.inkMuted }}>
            Per brief §10.3 dirty-form guard standard.
          </p>
        </Dialog>
      </div>
    );
  },
};
