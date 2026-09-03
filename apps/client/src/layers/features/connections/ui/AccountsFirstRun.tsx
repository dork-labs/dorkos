import { Button } from '@/layers/shared/ui';
import { FALLBACK_SERVICE_ICON, SERVICE_ICONS } from '../lib/presentation';

/**
 * The services worth naming before anything can be connected.
 *
 * Hardcoded on purpose. A live list comes from a carrier, and a fresh install
 * has no carrier, so asking for one would answer nothing — which is how this
 * region used to render an empty box that made the whole feature look broken.
 *
 * Every entry says Composio because that is the truth today: DorkOS has no
 * sign-in path of its own, so every account here is carried by Composio or
 * Nango. If a direct sign-in ever ships, the tiles it covers stop saying this
 * and start working straight away — the honest split the plan describes.
 */
const KNOWN_SERVICES: { slug: string; name: string }[] = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'github', name: 'GitHub' },
  { slug: 'linear', name: 'Linear' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'googlecalendar', name: 'Google Calendar' },
];

/**
 * What the Accounts region shows before any account can be connected.
 *
 * It never renders nothing. The services are named, and so is the one-time
 * setup standing between you and them, in the vendor's own name rather than a
 * word invented to avoid saying it.
 *
 * @param props - How to get to the setup this is waiting on.
 * @param props.onSetUpCarrier - Opens the Composio and Nango section.
 */
export function AccountsFirstRun({ onSetUpCarrier }: { onSetUpCarrier: () => void }) {
  return (
    <div className="space-y-4">
      <div className="bg-card shadow-soft space-y-3 rounded-lg border p-5">
        <p className="text-sm font-medium">Nothing can be connected yet</p>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
          Accounts reach DorkOS through Composio, an outside service that holds the sign-ins. It is
          a one-time setup and takes about two minutes. Your sign-ins live in Composio&rsquo;s
          vault, not on this machine.
        </p>
        <Button size="sm" onClick={onSetUpCarrier}>
          Set up Composio
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {KNOWN_SERVICES.map((service) => {
          const Icon = SERVICE_ICONS[service.slug] ?? FALLBACK_SERVICE_ICON;
          return (
            <div
              key={service.slug}
              data-testid={`service-preview-${service.slug}`}
              className="bg-card/50 flex flex-col items-start gap-2 rounded-lg border border-dashed p-4"
            >
              {/* `w-full`: the card is a column with `items-start`, which
                  sizes each child to its own content rather than stretching
                  it to the card's width — so without it, a long service name
                  had nothing forcing this row narrower than its own text and
                  painted past the card's padding instead of truncating
                  (DOR-1747). `min-w-0` is what then lets the row shrink
                  below that content size at all. */}
              <div className="flex w-full min-w-0 items-center gap-2">
                <Icon className="text-muted-foreground/60 size-4 shrink-0" aria-hidden />
                <span className="text-muted-foreground truncate text-sm font-medium">
                  {service.name}
                </span>
              </div>
              <span className="text-muted-foreground/70 text-xs">Connects through Composio</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
