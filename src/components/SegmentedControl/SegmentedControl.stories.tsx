import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { SegmentedControl } from './SegmentedControl.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof SegmentedControl> = {
  title: 'Primitives/SegmentedControl',
  component: SegmentedControl,
  parameters: { layout: 'centered' },
};
export default meta;

type CalendarView = 'today' | 'day' | 'week' | 'month';

export const CalendarView: StoryObj = {
  render: () => {
    const [view, setView] = useState<CalendarView>('today');
    return (
      <div style={{ padding: theme.space[8], background: theme.color.bg }}>
        <SegmentedControl<CalendarView>
          ariaLabel="Calendar view"
          value={view}
          onChange={setView}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
          ]}
        />
      </div>
    );
  },
};

type ReceiptChannel = 'email' | 'sms' | 'none';

export const ReceiptChannelV1: StoryObj = {
  render: () => {
    const [channel, setChannel] = useState<ReceiptChannel>('email');
    return (
      <div style={{ padding: theme.space[8], background: theme.color.bg, width: 420 }}>
        <SegmentedControl<ReceiptChannel>
          ariaLabel="Receipt channel"
          value={channel}
          onChange={setChannel}
          fullWidth
          options={[
            { value: 'email', label: 'Email' },
            { value: 'sms', label: 'SMS' },
            { value: 'none', label: 'None' },
          ]}
        />
        <p style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm, marginTop: theme.space[3] }}>
          Print is hidden in v1; no printer paired. Adds in v1.5.
        </p>
      </div>
    );
  },
};

export const Small: StoryObj = {
  render: () => {
    const [v, setV] = useState('a');
    return (
      <SegmentedControl
        size="sm"
        value={v}
        onChange={setV}
        options={[
          { value: 'a', label: 'Card' },
          { value: 'b', label: 'Cash' },
          { value: 'c', label: 'BNPL' },
        ]}
      />
    );
  },
};
