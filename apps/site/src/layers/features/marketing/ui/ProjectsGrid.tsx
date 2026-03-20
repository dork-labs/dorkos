import { ProjectCard } from './ProjectCard';
import type { Project } from '../lib/types';

interface ProjectsGridProps {
  projects: Project[];
}

export function ProjectsGrid({ projects }: ProjectsGridProps) {
  return (
    <section id="features" className="py-40">
      {/* Section Label */}
      <span className="text-2xs text-brand-orange mb-20 block text-center font-mono tracking-[0.15em] uppercase">
        Features
      </span>

      {/* Grid - 1px gap with border background */}
      <div
        className="grid grid-cols-1 md:grid-cols-2"
        style={{
          gap: '1px',
          backgroundColor: 'var(--border-warm)',
        }}
      >
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>
    </section>
  );
}
