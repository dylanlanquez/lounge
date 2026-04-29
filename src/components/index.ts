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

export { DropdownSelect } from './DropdownSelect/DropdownSelect.tsx';
export type { DropdownSelectProps, DropdownSelectOption } from './DropdownSelect/DropdownSelect.tsx';

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

export { WeekStrip } from './WeekStrip/WeekStrip.tsx';
export type { WeekStripProps } from './WeekStrip/WeekStrip.tsx';

export { BottomNav, BOTTOM_NAV_HEIGHT, shouldShowBottomNav } from './BottomNav/BottomNav.tsx';

export { SignaturePad, svgFromPath } from './SignaturePad/SignaturePad.tsx';
export type { SignaturePadProps, SignaturePadHandle } from './SignaturePad/SignaturePad.tsx';

export { WaiverSheet } from './WaiverSheet/WaiverSheet.tsx';
export type { WaiverSheetProps } from './WaiverSheet/WaiverSheet.tsx';

export { WaiverInline } from './WaiverInline/WaiverInline.tsx';
export type { WaiverInlineProps } from './WaiverInline/WaiverInline.tsx';

export { BeforeAfterGallery, MarketingGallery } from './PhotoGallery/PhotoGallery.tsx';

export { StickyPageHeader } from './StickyPageHeader/StickyPageHeader.tsx';
export type { StickyPageHeaderProps } from './StickyPageHeader/StickyPageHeader.tsx';

export { ErrorBoundary } from './ErrorBoundary/ErrorBoundary.tsx';

export { CollapsibleCard } from './CollapsibleCard/CollapsibleCard.tsx';
export type { CollapsibleCardProps } from './CollapsibleCard/CollapsibleCard.tsx';

export { PatientFilesGrid } from './PatientFilesGrid/PatientFilesGrid.tsx';

export { FinalDeliveries } from './FinalDeliveries/FinalDeliveries.tsx';
