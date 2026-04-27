import type { Meta, StoryObj } from '@storybook/react';
import { Breadcrumb } from './Breadcrumb.tsx';

const meta: Meta<typeof Breadcrumb> = {
  title: 'Primitives/Breadcrumb',
  component: Breadcrumb,
  parameters: { layout: 'centered' },
};
export default meta;

type S = StoryObj<typeof Breadcrumb>;

export const VisitDetail: S = {
  args: {
    items: [
      { label: 'Today', href: '#' },
      { label: 'Sarah Henderson', href: '#' },
      { label: 'Visit detail' },
    ],
  },
};

export const Admin: S = {
  args: {
    items: [
      { label: 'Admin', href: '#' },
      { label: 'Devices', href: '#' },
      { label: 'Motherwell counter' },
    ],
  },
};
