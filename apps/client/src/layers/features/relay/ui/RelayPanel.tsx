import { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Route } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent, FeatureDisabledState } from '@/layers/shared/ui';
import { useRelayEnabled, useRelayEventStream, useAdapterCatalog } from '@/layers/entities/relay';
import { ActivityFeed } from './ActivityFeed';
import { ConnectionStatusBanner } from './ConnectionStatusBanner';
import { ConnectionsTab } from './ConnectionsTab';
import { RelayEmptyState } from './RelayEmptyState';
import { RelayHealthBar } from './RelayHealthBar';

/** Main Relay panel — progressive disclosure based on adapter configuration state. */
export function RelayPanel() {
  const relayEnabled = useRelayEnabled();
  const [activeTab, setActiveTab] = useState('connections');
  const [showCatalog, setShowCatalog] = useState(false);
  const [autoShowFailures, setAutoShowFailures] = useState(false);
  const deadLetterRef = useRef<HTMLDivElement>(null);

  // Connect SSE stream when relay is enabled; track connection health for banner
  const { connectionState } = useRelayEventStream(relayEnabled);

  // Mode A/B: determine whether any adapters are configured
  const { data: catalog = [] } = useAdapterCatalog(relayEnabled);
  const hasConfiguredAdapters = catalog.some((entry) => entry.instances.length > 0);

  /**
   * Switch to the activity tab, force the dead-letter section open, then scroll to it.
   * The 100ms tasks on autoShowFailures lets the useEffect in ActivityFeed fire even
   * on repeated clicks (value goes true → false → true each time).
   */
  const handleFailedClick = useCallback(() => {
    setActiveTab('activity');
    setAutoShowFailures(true);
    setTimeout(() => setAutoShowFailures(false), 100);
    setTimeout(() => {
      deadLetterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  }, []);

  if (!relayEnabled) {
    return (
      <FeatureDisabledState
        icon={Route}
        name="Relay"
        description="Relay provides inter-agent messaging. Start DorkOS with relay enabled."
        command="DORKOS_RELAY_ENABLED=true dorkos"
      />
    );
  }

  return (
    <AnimatePresence mode="wait">
      {hasConfiguredAdapters ? (
        <motion.div
          key="mode-b"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex h-full flex-col"
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
            <RelayHealthBar enabled={relayEnabled} onFailedClick={handleFailedClick} />
            <ConnectionStatusBanner connectionState={connectionState} className="mx-4 mt-2" />

            <TabsList className="mx-4 mt-3 shrink-0">
              <TabsTrigger value="connections">Connections</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>

            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="min-h-0 flex-1 overflow-y-auto"
              >
                <TabsContent value="connections" className="h-full">
                  <ConnectionsTab enabled={relayEnabled} />
                </TabsContent>

                <TabsContent value="activity" className="h-full">
                  <ActivityFeed
                    enabled={relayEnabled}
                    deadLetterRef={deadLetterRef}
                    onSwitchToChannels={() => setActiveTab('connections')}
                    autoShowFailures={autoShowFailures}
                  />
                </TabsContent>
              </motion.div>
            </AnimatePresence>
          </Tabs>
        </motion.div>
      ) : (
        <motion.div
          key="mode-a"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex h-full flex-col"
        >
          {showCatalog ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ConnectionsTab enabled={relayEnabled} />
            </div>
          ) : (
            <RelayEmptyState onAddChannel={() => setShowCatalog(true)} />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
