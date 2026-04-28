// Custom in-clinic glyph (replaces the previous tooth outline). Path
// data lifted verbatim from the asset Dylan provided. Filled, not
// stroked — silhouette legibility, same as CalendarIcon. The name
// "ToothIcon" is preserved for backwards compatibility with the
// schedule-detail empty state and admin chrome that already import
// it; renaming would touch unrelated callers.

export interface ToothIconProps {
  size?: number;
  color?: string;
  title?: string;
}

export function ToothIcon({ size = 22, color = 'currentColor', title }: ToothIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 383.99 384"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ flexShrink: 0 }}
    >
      <path
        fill={color}
        d="M307.5,0l-.35,203.98,41.04,18.58c20.1,9.1,33.55,27.5,35.8,48.94v10.89c-1.03,7.27-3.38,14.64-6.81,21.99l-3.25,6.96-96.3-43.77-18.75.05,17.69,45.96c35.18-1.8,63.19,26.61,62.59,61.47l-.18,8.96H92.76s-.12-7.53-.12-7.53c-1.04-29.83,18.65-56.06,48.2-61.97l-20.88-54.19L0,158.99v-.63c1.9-1.6,3.81-3.58,5.49-5.76,20.54-26.58,58.81-30.96,84.64-9.32l64.1,54.19,130.44-.03V22.5s-40.04,0-40.04,0l-22.22,22.17c22.26,25.99,23.05,63.98,1.88,90.98l-30.29-.14L117.77,56.95v-28.08c26.35-20.29,62.24-20.28,88.48.05L234.96,0h72.54ZM203.54,113.07h8.55c9.97-20.48,4.96-44.59-12.38-59.27-14.73-17.47-38.88-22.59-59.39-12.59l.08,6.74,63.15,65.12ZM342.17,244.62l-54.39-24.7-141.82.04-69.39-58.69c-12.07-10.66-29.43-12.39-43.32-3.81l103.49,87.6h145.79s78.56,35.73,78.56,35.73c1.68-14.78-5.59-28.59-18.92-36.16ZM252.39,313.46l-17.61-45.9h-87.89s17.68,45.97,17.68,45.97l87.82-.06ZM314.82,361.49c-4.83-15.07-18.71-25.5-35.12-25.5l-128.18.03c-16.18,0-29.94,10.89-34.46,25.47h197.75Z"
      />
    </svg>
  );
}
