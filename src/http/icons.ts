/**
 * Tab-icon markup copied from Command Center: the sign-in page's icon links,
 * plus the manifest link its access page adds for the same files.
 */
export const ICON_LINK_TAGS = [
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  '<link rel="manifest" href="/manifest.webmanifest">',
] as const;

export const ICON_LINKS = ICON_LINK_TAGS.join("");
