import { PostHog } from 'posthog-node'
import { env } from '../env'

let posthogClient: PostHog | null = null

export function getPostHogClient() {
  if (!posthogClient) {
    posthogClient = new PostHog(env.NEXT_PUBLIC_POSTHOG_KEY ?? '', {
      host: env.NEXT_PUBLIC_POSTHOG_HOST,
      // Because server-side functions in Next.js can be short-lived,
      // we set flushAt to 1 and flushInterval to 0 to send events immediately
      flushAt: 1,
      flushInterval: 0,
    })
  }
  return posthogClient
}

export async function shutdownPostHog() {
  if (posthogClient) {
    await posthogClient.shutdown()
  }
}
