// Lounge design-system primitive exports.
// Per brief §9.7, components are built one at a time, in a fixed order.
// This file is the single import surface for app code: `import { Button } from '@/components';`
// (Storybook imports from per-component files directly.)

export { Button } from './Button/Button.tsx';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button/Button.tsx';

export { Input } from './Input/Input.tsx';
export type { InputProps } from './Input/Input.tsx';

export { Card } from './Card/Card.tsx';
export type { CardProps, CardPadding, CardElevation } from './Card/Card.tsx';

export { StatusPill } from './StatusPill/StatusPill.tsx';
export type { StatusPillProps, StatusTone } from './StatusPill/StatusPill.tsx';

export { SegmentedControl } from './SegmentedControl/SegmentedControl.tsx';
export type { SegmentedControlOption, SegmentedControlProps } from './SegmentedControl/SegmentedControl.tsx';

export { Toast } from './Toast/Toast.tsx';
export type { ToastProps, ToastTone } from './Toast/Toast.tsx';
