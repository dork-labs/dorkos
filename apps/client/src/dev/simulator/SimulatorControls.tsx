import { useCallback } from 'react';
import { Play, Pause, SkipForward, RotateCcw } from 'lucide-react';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { TextEffectMode } from '@/layers/shared/lib';
import type { SimScenario } from './sim-types';
import type { SimulatorResult } from './use-simulator';
import { SPEED_PRESETS } from './use-simulator';

interface SimulatorControlsProps {
  scenarios: SimScenario[];
  selectedScenarioId: string;
  onScenarioChange: (id: string) => void;
  sim: SimulatorResult;
  textEffectMode: TextEffectMode;
  onTextEffectModeChange: (mode: TextEffectMode) => void;
  animationEnabled: boolean;
  onAnimationEnabledChange: (enabled: boolean) => void;
}

/** Transport-style control bar for the chat simulator. */
export function SimulatorControls({
  scenarios,
  selectedScenarioId,
  onScenarioChange,
  sim,
  textEffectMode,
  onTextEffectModeChange,
  animationEnabled,
  onAnimationEnabledChange,
}: SimulatorControlsProps) {
  const isPlaying = sim.phase === 'playing';
  const isDone = sim.phase === 'done';
  const canPlay = !isPlaying && !isDone;
  const canStep = sim.phase !== 'playing' && sim.phase !== 'done';

  const handleSeek = useCallback(
    (value: number[]) => {
      sim.seekTo(value[0]);
    },
    [sim],
  );

  return (
    <div className="border-b px-4 py-3">
      {/* Top row: scenario picker + transport buttons + speed */}
      <div className="flex items-center gap-3">
        {/* Scenario picker */}
        <Select value={selectedScenarioId} onValueChange={onScenarioChange}>
          <SelectTrigger className="h-8 w-52 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {scenarios.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Transport buttons */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={sim.reset}
            aria-label="Reset"
          >
            <RotateCcw className="size-3.5" />
          </Button>
          {isPlaying ? (
            <Button
              variant="outline"
              size="icon-sm"
              onClick={sim.pause}
              aria-label="Pause"
            >
              <Pause className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="default"
              size="icon-sm"
              onClick={sim.play}
              disabled={!canPlay}
              aria-label="Play"
            >
              <Play className="size-3.5" />
            </Button>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            onClick={sim.step}
            disabled={!canStep}
            aria-label="Step forward"
          >
            <SkipForward className="size-3.5" />
          </Button>
        </div>

        {/* Speed selector */}
        <div className="ml-auto flex items-center gap-1">
          <span className="text-muted-foreground text-xs">Speed</span>
          <div className="flex gap-0.5">
            {SPEED_PRESETS.map((preset) => (
              <Button
                key={preset}
                variant={sim.speed === preset ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-1.5 text-xs"
                onClick={() => sim.setSpeed(preset)}
              >
                {preset}x
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom row: timeline + step counter + phase badge */}
      <div className="mt-2.5 flex items-center gap-3">
        <Slider
          min={0}
          max={sim.totalSteps}
          step={1}
          value={[sim.stepIndex]}
          onValueChange={handleSeek}
          className="flex-1"
          aria-label="Timeline"
        />
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          {sim.stepIndex}/{sim.totalSteps}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
            sim.phase === 'idle' && 'bg-muted text-muted-foreground',
            sim.phase === 'playing' && 'bg-green-500/15 text-green-600 dark:text-green-400',
            sim.phase === 'paused' && 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
            sim.phase === 'done' && 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
          )}
        >
          {sim.phase}
        </span>
      </div>

      {/* Effect controls row */}
      <div className="mt-2 flex items-center gap-3 border-t border-dashed pt-2">
        <span className="text-muted-foreground text-xs">Text Effect</span>
        <Select
          value={textEffectMode}
          onValueChange={(v) => onTextEffectModeChange(v as TextEffectMode)}
        >
          <SelectTrigger className="h-7 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="fade">Fade In</SelectItem>
            <SelectItem value="blur-in">Blur In</SelectItem>
            <SelectItem value="slide-up">Slide Up</SelectItem>
          </SelectContent>
        </Select>

        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Switch
            size="sm"
            checked={animationEnabled}
            onCheckedChange={onAnimationEnabledChange}
            aria-label="Toggle text animation"
          />
          Animation
        </div>
      </div>
    </div>
  );
}
