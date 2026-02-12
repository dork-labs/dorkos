// roadmap/roadmap.ts
import roadmapData from './roadmap.json'
import type { Roadmap } from '@/layers/features/roadmap/model/types'

// Re-export with proper typing
// The JSON is imported at build time and bundled with the app
export const roadmap: Roadmap = roadmapData as Roadmap

// Helper exports for common use cases
export function getRoadmapItems() {
  return roadmap.items
}

export function getRoadmapMetadata() {
  return {
    projectName: roadmap.projectName,
    projectSummary: roadmap.projectSummary,
    lastUpdated: roadmap.lastUpdated,
    timeHorizons: roadmap.timeHorizons,
  }
}

export function getItemById(id: string) {
  return roadmap.items.find(item => item.id === id) ?? null
}

export function getItemsByStatus(status: string) {
  return roadmap.items.filter(item => item.status === status)
}

export function getItemsByTimeHorizon(horizon: string) {
  return roadmap.items.filter(item => item.timeHorizon === horizon)
}
