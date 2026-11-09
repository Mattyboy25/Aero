import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const Base = ({ children, ...p }: P) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>{children}</svg>
);

export const IconPlay = (p: P) => <Base {...p}><path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none" /></Base>;
export const IconPause = (p: P) => <Base {...p}><path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z" fill="currentColor" stroke="none" /></Base>;
export const IconPlus = (p: P) => <Base {...p}><path d="M12 5v14M5 12h14" /></Base>;
export const IconSidebar = (p: P) => <Base {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M9.5 4.5v15" /></Base>;
export const IconSun = (p: P) => <Base {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" /></Base>;
export const IconMoon = (p: P) => <Base {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></Base>;
export const IconMonitor = (p: P) => <Base {...p}><rect x="3" y="4.5" width="18" height="12" rx="2.5" /><path d="M8.5 20h7M12 16.5V20" /></Base>;
export const IconTrash = (p: P) => <Base {...p}><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" /></Base>;
export const IconFilm = (p: P) => <Base {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4" /></Base>;
export const IconDownload = (p: P) => <Base {...p}><path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" /></Base>;
export const IconArrowUp = (p: P) => <Base {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Base>;
export const IconStop = (p: P) => <Base {...p}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></Base>;
export const IconChevron = (p: P) => <Base {...p}><path d="M6 9.5l6 6 6-6" /></Base>;
export const IconSparkle = (p: P) => <Base {...p}><path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z" /><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></Base>;
export const IconCopy = (p: P) => <Base {...p}><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></Base>;
export const IconStepBack = (p: P) => <Base {...p}><path d="M6.5 5v14" /><path d="M18 5.5v13L9 12z" fill="currentColor" stroke="none" /></Base>;
export const IconStepForward = (p: P) => <Base {...p}><path d="M17.5 5v14" /><path d="M6 5.5v13L15 12z" fill="currentColor" stroke="none" /></Base>;
export const IconCheck = (p: P) => <Base {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Base>;
export const IconSettings = (p: P) => <Base {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></Base>;
export const IconClose = (p: P) => <Base {...p}><path d="M6 6l12 12M18 6L6 18" /></Base>;
export const IconSelector = (p: P) => <Base {...p}><path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4" /></Base>;
