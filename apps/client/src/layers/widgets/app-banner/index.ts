/**
 * App banner widget — the single global banner slot that sits below the app
 * header, plus the priority-ranked descriptors that feed it. Renders one standing
 * banner at a time (critical > warning > info > neutral), never a stack.
 *
 * @module widgets/app-banner
 */
export { AppBannerSlot } from './ui/AppBannerSlot';
export { PermissionBanner } from './ui/PermissionBanner';
export { useAppBanners } from './model/use-app-banners';
export { BANNER_PRIORITY, type BannerDescriptor } from './model/banner-descriptor';
