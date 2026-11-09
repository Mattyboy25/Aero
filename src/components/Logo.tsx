// The Aero logo. It draws in the current text color, so it follows the theme.
export const Logo = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 490 490" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
    <path
      d="M245 24.5C123.223 24.5 24.5 123.223 24.5 245s98.723 220.5 220.5 220.5 220.5-98.723 220.5-220.5S366.777 24.5 245 24.5Z"
      stroke="currentColor" strokeWidth="30.625"
    />
    <g stroke="currentColor" strokeWidth="24.5" strokeLinecap="round">
      <path d="M245 98v73.5" />
      <path d="M392 245h-73.5" />
      <path d="M245 392v-73.5" />
      <path d="M98 245h73.5" />
      <path d="m348.941 141.059-51.965 51.965" />
      <path d="m348.941 348.941-51.965-51.965" />
      <path d="m141.059 348.941 51.965-51.965" />
      <path d="m141.059 141.059 51.965 51.965" />
    </g>
    <path d="M294 245a49 49 0 0 1-49 49 49 49 0 0 1-49-49 49 49 0 0 1 98 0" fill="currentColor" />
  </svg>
);
