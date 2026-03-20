import Link from 'next/link';
import type { Project } from '../lib/types';

interface ProjectCardProps {
  project: Project;
}

/** Feature card — title + description, optional link. */
export function ProjectCard({ project }: ProjectCardProps) {
  const content = (
    <>
      <h3 className="text-charcoal mb-3 text-xl font-semibold tracking-[-0.01em]">
        {project.title}
      </h3>
      <p className="text-warm-gray text-sm leading-relaxed">{project.description}</p>
    </>
  );

  const baseClassName = 'text-center py-12 px-6 bg-cream-primary transition-smooth';
  const hoverClassName = project.href ? 'hover:bg-cream-secondary cursor-pointer' : '';

  if (project.href) {
    return (
      <Link
        href={project.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${baseClassName} ${hoverClassName}`}
      >
        {content}
      </Link>
    );
  }

  return <article className={baseClassName}>{content}</article>;
}
