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

export { Skeleton } from './Skeleton/Skeleton.tsx';
export type { SkeletonProps } from './Skeleton/Skeleton.tsx';

export { EmptyState } from './EmptyState/EmptyState.tsx';
export type { EmptyStateProps } from './EmptyState/EmptyState.tsx';

export { Avatar } from './Avatar/Avatar.tsx';
export type { AvatarProps, AvatarSize } from './Avatar/Avatar.tsx';

export { Breadcrumb } from './Breadcrumb/Breadcrumb.tsx';
export type { BreadcrumbProps, BreadcrumbItem } from './Breadcrumb/Breadcrumb.tsx';

export { BottomSheet } from './BottomSheet/BottomSheet.tsx';
export type { BottomSheetProps } from './BottomSheet/BottomSheet.tsx';

export { Dialog } from './Dialog/Dialog.tsx';
export type { DialogProps } from './Dialog/Dialog.tsx';

export { Sidebar } from './Sidebar/Sidebar.tsx';
export type { SidebarProps, SidebarItem, SidebarSection } from './Sidebar/Sidebar.tsx';

export { KeyboardAwareScroll } from './KeyboardAwareScroll/KeyboardAwareScroll.tsx';
export type { KeyboardAwareScrollProps } from './KeyboardAwareScroll/KeyboardAwareScroll.tsx';
