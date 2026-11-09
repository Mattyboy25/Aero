// The Aero logo (public/aero.svg, white artwork). It is used as a mask over the current text
// color, so it follows the theme: dark in light mode, light in dark mode.
export const Logo = ({ className = "" }: { className?: string }) => (
  <span className={className} style={{ ["--logo" as string]: `url(${import.meta.env.BASE_URL}aero.svg)` }} aria-hidden="true" />
);
