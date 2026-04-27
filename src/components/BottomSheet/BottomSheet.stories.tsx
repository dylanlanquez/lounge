import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { BottomSheet } from './BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof BottomSheet> = {
  title: 'Primitives/BottomSheet',
  component: BottomSheet,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type S = StoryObj<typeof BottomSheet>;

export const VisitDetail: S = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div style={{ height: '100dvh', background: theme.color.bg, padding: theme.space[8] }}>
        <Button onClick={() => setOpen(true)}>Open visit detail</Button>
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          title="Sarah H."
          description="Walk-in. LWO-20260427-0001."
          footer={
            <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
              <Button variant="secondary">Edit details</Button>
              <Button variant="primary" showArrow>Build cart</Button>
            </div>
          }
        >
          <p style={{ color: theme.color.inkMuted, margin: 0 }}>
            Arrived 10:32. Service: denture repair. Reason: lost crown. Marked arrived 12 seconds ago.
          </p>
        </BottomSheet>
      </div>
    );
  },
};

export const CreateAppointment: S = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div style={{ height: '100dvh', background: theme.color.bg, padding: theme.space[8] }}>
        <Button onClick={() => setOpen(true)}>Open create appointment</Button>
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          title="New appointment"
          description="11:00, Mark on Tuesday."
          footer={
            <Button variant="primary" fullWidth showArrow>
              Save appointment
            </Button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            <Input label="Patient" placeholder="Search by phone, name, or LWO ref" />
            <Input label="Service type" placeholder="e.g. denture repair" />
          </div>
        </BottomSheet>
      </div>
    );
  },
};

export const NotDismissable: S = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div style={{ height: '100dvh', background: theme.color.bg, padding: theme.space[8] }}>
        <Button onClick={() => setOpen(true)}>Open BNPL pre-flight</Button>
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          dismissable={false}
          title="Before they tap"
          description="Confirm the customer is set up before sending the payment to the reader."
          footer={
            <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'space-between' }}>
              <Button variant="tertiary" onClick={() => setOpen(false)}>Switch to card</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>Yes, they have it</Button>
            </div>
          }
        >
          <p style={{ margin: 0, color: theme.color.ink }}>
            Does the customer already have the Klarna app, with Apple Pay or Google Pay set up on their phone?
          </p>
        </BottomSheet>
      </div>
    );
  },
};
