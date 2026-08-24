export interface NavLink {
  label: string;
  href: string;
  /**
   * Drop this destination on the narrowest screens, where the pill only has
   * room for five words. Reserved for a destination the page reaches another
   * way, so nothing becomes unreachable on a phone.
   */
  yieldsOnMobile?: boolean;
}
