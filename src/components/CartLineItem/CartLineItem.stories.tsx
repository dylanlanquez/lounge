import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { CartLineItem } from './CartLineItem.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof CartLineItem> = {
  title: 'Primitives/CartLineItem',
  component: CartLineItem,
  parameters: { layout: 'centered' },
  decorators: [(Story) => <div style={{ width: 520, padding: theme.space[6], background: theme.color.bg }}><Story /></div>],
};
export default meta;

type S = StoryObj<typeof CartLineItem>;

export const Single: S = {
  render: () => {
    const [q, setQ] = useState(1);
    const unit = 4500;
    return (
      <CartLineItem
        name="Consultation"
        description="30 min"
        quantity={q}
        unitPricePence={unit}
        lineTotalPence={unit * q}
        onIncrement={() => setQ(q + 1)}
        onDecrement={() => setQ(q - 1)}
        onRemove={() => alert('removed')}
      />
    );
  },
};
