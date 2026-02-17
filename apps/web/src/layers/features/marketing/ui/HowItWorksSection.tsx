'use client'

import { useEffect, useRef, useState } from 'react'

interface Step {
  number: string
  command: string
  description: string
}

const steps: Step[] = [
  {
    number: '01',
    command: 'npm install -g dorkos',
    description:
      'One command. No config files. No Docker. No cloud account.',
  },
  {
    number: '02',
    command: 'dorkos --dir ~/projects',
    description:
      'Server starts at localhost:4242. Add --tunnel for remote access from anywhere.',
  },
  {
    number: '03',
    command: 'Your agents are running.',
    description:
      'Tool approvals, session history, slash commands. Autonomous execution with full control.',
  },
]

/** Terminal block with optional typing animation. */
function TerminalBlock({ text, animate }: { text: string; animate: boolean }) {
  const [displayText, setDisplayText] = useState(text)
  const hasAnimated = useRef(false)

  useEffect(() => {
    if (!animate || hasAnimated.current) return
    hasAnimated.current = true
    setDisplayText('')
    let i = 0
    const interval = setInterval(() => {
      i++
      setDisplayText(text.slice(0, i))
      if (i >= text.length) {
        clearInterval(interval)
      }
    }, 50)
    return () => clearInterval(interval)
  }, [animate, text])

  return (
    <div className="bg-cream-secondary rounded-lg px-4 py-3 font-mono text-sm text-charcoal mb-4">
      <span>{displayText}</span>
      <span className="cursor-blink" aria-hidden="true" />
    </div>
  )
}

/** 3-step install/run/work section with scroll-triggered terminal animation. */
export function HowItWorksSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.3 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <section ref={sectionRef} className="py-40 px-8 bg-cream-primary">
      <span className="font-mono text-2xs tracking-[0.15em] uppercase text-brand-orange text-center block mb-20">
        How It Works
      </span>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-12 max-w-5xl mx-auto">
        {steps.map((step, index) => (
          <div key={step.number} className="text-center">
            <span className="font-mono text-2xs tracking-[0.1em] text-brand-green block mb-4">
              {step.number}
            </span>
            <TerminalBlock
              text={step.command}
              animate={isVisible && index < 2}
            />
            <p className="text-warm-gray text-sm leading-relaxed">
              {step.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
