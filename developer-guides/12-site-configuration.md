# Site Configuration

## Quick Reference

| Config Location | Purpose |
|-----------------|---------|
| `site.config.ts` | Root configuration file |
| `src/config/types.ts` | TypeScript interface |
| `src/config/index.ts` | Config loader with env override |

| Environment Variable | Config Override | Type |
|---------------------|-----------------|------|
| `NEXT_PUBLIC_SITE_NAME` | `name` | string |
| `NEXT_PUBLIC_SITE_URL` | `url` | string |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | `description` | string |
| `NEXT_PUBLIC_COOKIE_BANNER_ENABLED` | `features.cookieBanner` | boolean |
| `NEXT_PUBLIC_ANALYTICS_ENABLED` | `features.analytics` | boolean |

## Configuration Structure

### Complete Interface

```typescript
interface SiteConfig {
  // Site Identity
  name: string              // Company/site name
  description: string       // Site description for metadata
  url: string              // Base URL for canonical links

  // Contact Information
  contact: {
    email?: string          // General contact
    privacyEmail?: string   // Privacy inquiries
    legalEmail?: string     // Legal inquiries
  }

  // Social Links
  links: {
    twitter?: string
    github?: string
    linkedin?: string
  }

  // Feature Toggles
  features: {
    cookieBanner: boolean   // Show/hide cookie consent banner
    analytics: boolean      // Enable PostHog analytics
    legalPages: {
      privacy: boolean      // Show privacy link in footer
      terms: boolean        // Show terms link in footer
      cookies: boolean      // Show cookies link in footer
    }
  }

  // SEO Configuration
  seo: {
    ogImage?: string        // Default Open Graph image
    twitterCard?: 'summary' | 'summary_large_image'
  }
}
```

## Usage Patterns

### Reading Configuration

```typescript
import { getSiteConfig } from '@/config'

// In a component or page
const config = getSiteConfig()
console.log(config.name)  // "Your Company"
```

### Conditional Rendering

```typescript
const config = getSiteConfig()

// Feature toggle pattern
if (!config.features.cookieBanner) return null

// Conditional links
{config.features.legalPages.privacy && <Link href="/privacy">Privacy</Link>}
```

### Environment Override

Environment variables take precedence over config file values:

```bash
# .env.local
NEXT_PUBLIC_SITE_NAME=Production Site
NEXT_PUBLIC_COOKIE_BANNER_ENABLED=false
```

## Feature Toggles Reference

| Toggle | Default | Effect |
|--------|---------|--------|
| `features.cookieBanner` | `true` | Show/hide cookie consent banner |
| `features.analytics` | `true` | Enable/disable PostHog tracking |
| `features.legalPages.privacy` | `true` | Show/hide privacy link in footer |
| `features.legalPages.terms` | `true` | Show/hide terms link in footer |
| `features.legalPages.cookies` | `true` | Show/hide cookies link in footer |

## Adding New Configuration Options

1. **Add to interface** (`src/config/types.ts`):
```typescript
export interface SiteConfig {
  // ... existing fields
  newOption: string
}
```

2. **Add to config file** (`site.config.ts`):
```typescript
export const siteConfig: SiteConfig = {
  // ... existing values
  newOption: 'default value',
}
```

3. **Add env override** (optional, `src/config/index.ts`):
```typescript
export function getSiteConfig(): SiteConfig {
  return {
    ...baseConfig,
    newOption: process.env.NEXT_PUBLIC_NEW_OPTION ?? baseConfig.newOption,
  }
}
```

4. **Use in components**:
```typescript
const config = getSiteConfig()
// Use config.newOption
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Import from `../../site.config` directly | Use `getSiteConfig()` from `@/config` |
| Hardcode site name in components | Use `config.name` |
| Check env vars directly in components | Let config loader handle env overrides |

## Troubleshooting

### Config Changes Not Reflected

**Symptom**: Changed `site.config.ts` but pages show old values

**Cause**: Next.js caching

**Solution**: Restart dev server or clear `.next` cache

### Environment Override Not Working

**Symptom**: Set env var but config value unchanged

**Checklist**:
1. Variable starts with `NEXT_PUBLIC_`?
2. Variable in `.env.local` (not `.env`)?
3. Dev server restarted after adding env var?
4. Boolean values are exactly `'true'` or `'false'`?

### TypeScript Errors in Config

**Symptom**: Type errors when editing `site.config.ts`

**Solution**: Ensure all required fields are present. Run `pnpm typecheck` to see specific errors.
