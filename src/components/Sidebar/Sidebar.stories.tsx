import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import {
  Calendar,
  Users,
  CreditCard,
  Receipt,
  Settings,
  HelpCircle,
  AlertTriangle,
  Home,
} from 'lucide-react';
import { Sidebar, type SidebarSection } from './Sidebar.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';
import { StatusPill } from '../StatusPill/StatusPill.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof Sidebar> = {
  title: 'Primitives/Sidebar',
  component: Sidebar,
  parameters: { layout: 'fullscreen' },
};
export default meta;

const SECTIONS: SidebarSection[] = [
  {
    id: 'main',
    items: [
      { id: 'today', label: 'Today', icon: <Home size={18} /> },
      { id: 'calendar', label: 'Calendar', icon: <Calendar size={18} /> },
      { id: 'patients', label: 'Patients', icon: <Users size={18} /> },
    ],
  },
  {
    id: 'epos',
    label: 'EPOS',
    items: [
      { id: 'till', label: 'Till', icon: <CreditCard size={18} /> },
      { id: 'receipts', label: 'Receipts', icon: <Receipt size={18} /> },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    items: [
      { id: 'settings', label: 'Settings', icon: <Settings size={18} /> },
      {
        id: 'failures',
        label: 'System failures',
        icon: <AlertTriangle size={18} />,
        badge: <StatusPill tone="no_show" size="sm">3</StatusPill>,
      },
      { id: 'help', label: 'Help', icon: <HelpCircle size={18} /> },
    ],
  },
];

export const Default: StoryObj = {
  render: () => {
    const [active, setActive] = useState('today');
    return (
      <div style={{ display: 'flex', height: '100dvh', background: theme.color.bg }}>
        <Sidebar
          activeId={active}
          sections={SECTIONS.map((s) => ({
            ...s,
            items: s.items.map((i) => ({ ...i, onClick: () => setActive(i.id) })),
          }))}
          brand={
            <img src="/lounge-logo.png" alt="Lounge" style={{ width: 100, height: 'auto' }} />
          }
          footer={
            <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
              <Avatar name="Dylan Lanquez" size="md" badge="online" />
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                  Dylan Lanquez
                </p>
                <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                  Motherwell · Receptionist
                </p>
              </div>
            </div>
          }
        />
        <main style={{ flex: 1, padding: theme.space[8], overflow: 'auto' }}>
          <p style={{ color: theme.color.inkMuted }}>Active: {active}</p>
        </main>
      </div>
    );
  },
};
