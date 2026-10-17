export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <rect width="64" height="64" rx="15" fill="var(--accent)" />
      <g fill="none" stroke="var(--accent-text)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="12" y="14" width="18" height="14" rx="3" />
        <rect x="34" y="36" width="18" height="14" rx="3" />
        <path d="M30 21h6a5 5 0 0 1 5 5v10" />
      </g>
    </svg>
  );
}
